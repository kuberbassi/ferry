mod session;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Path, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use session::{
    is_valid_token_format, ClientSignal, ExpiryPolicy, ServerSignal, SessionStore,
    DEFAULT_TTL_SECS, MAX_TTL_SECS,
};
use std::{
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
};
use tracing::{info, warn};

#[derive(Clone)]
struct AppState {
    store: SessionStore,
    ice_servers: Vec<IceServerConfig>,
}

#[derive(Debug, Clone, Serialize)]
struct IceServerConfig {
    urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
    active_sessions: usize,
}

#[derive(Debug, Serialize)]
struct ClientConfigResponse {
    ice_servers: Vec<IceServerConfig>,
    default_ttl_seconds: u64,
    max_ttl_seconds: u64,
    has_turn_relay: bool,
}

#[derive(Debug, Deserialize)]
struct CreateSessionRequest {
    #[serde(default)]
    expiry_policy: ExpiryPolicy,
    ttl_seconds: Option<u64>,
    label: Option<String>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ferry_signalling=info,tower_http=info".into()),
        )
        .init();

    let store = SessionStore::new();
    let ice_servers = load_ice_servers_from_env();

    let reaper_store = store.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        loop {
            interval.tick().await;
            let reaped = reaper_store.reap_expired().await;
            if reaped > 0 {
                info!("Reaped {} expired transfer session(s)", reaped);
            }
        }
    });

    let state = AppState { store, ice_servers };

    let mut app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/config", get(config_handler))
        .route("/api/sessions", post(create_session_handler))
        .route("/api/sessions/{id}", get(get_session_handler))
        .route("/api/sessions/{id}", delete(delete_session_handler))
        .route("/ws", get(ws_handler));

    if let Ok(static_dir) = std::env::var("STATIC_DIR") {
        let index_path = format!("{}/index.html", static_dir.trim_end_matches('/'));
        info!("Serving static frontend from {}", static_dir);
        app = app.fallback_service(
            ServeDir::new(&static_dir).not_found_service(ServeFile::new(index_path)),
        );
    }

    let app = app
        .layer(middleware::from_fn(security_headers_middleware))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8787);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    info!("Ferry signalling server listening on http://{}", addr);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP listener");

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .expect("Server error");
}

fn load_ice_servers_from_env() -> Vec<IceServerConfig> {
    let mut servers = vec![IceServerConfig {
        urls: vec![
            "stun:stun.cloudflare.com:3478".to_string(),
            "stun:stun.l.google.com:19302".to_string(),
            "stun:stun1.l.google.com:19302".to_string(),
        ],
        username: None,
        credential: None,
    }];

    if let Ok(turn_url) = std::env::var("TURN_URL") {
        let turn_url = turn_url.trim().to_string();
        if !turn_url.is_empty() {
            servers.push(IceServerConfig {
                urls: vec![turn_url],
                username: std::env::var("TURN_USERNAME").ok(),
                credential: std::env::var("TURN_CREDENTIAL").ok(),
            });
        }
    }

    servers
}

async fn health_handler(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: "1",
        active_sessions: state.store.active_count().await,
    })
}

async fn config_handler(State(state): State<AppState>) -> Json<ClientConfigResponse> {
    let has_turn_relay = state
        .ice_servers
        .iter()
        .any(|s| s.urls.iter().any(|u| u.starts_with("turn:") || u.starts_with("turns:")));

    Json(ClientConfigResponse {
        ice_servers: state.ice_servers,
        default_ttl_seconds: DEFAULT_TTL_SECS,
        max_ttl_seconds: MAX_TTL_SECS,
        has_turn_relay,
    })
}

async fn security_headers_middleware(
    req: axum::extract::Request,
    next: Next,
) -> impl IntoResponse {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

fn extract_client_ip(headers: &HeaderMap, fallback: IpAddr) -> IpAddr {
    if let Some(cf_ip) = headers
        .get("cf-connecting-ip")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<IpAddr>().ok())
    {
        return cf_ip;
    }
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            if let Ok(ip) = first.trim().parse::<IpAddr>() {
                return ip;
            }
        }
    }
    fallback
}

async fn create_session_handler(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<CreateSessionRequest>,
) -> impl IntoResponse {
    let client_ip = extract_client_ip(&headers, addr.ip());
    match state
        .store
        .create_session(
            payload.expiry_policy,
            payload.ttl_seconds,
            payload.label,
            Some(client_ip),
        )
        .await
    {
        Ok(res) => (StatusCode::CREATED, Json(serde_json::to_value(res).unwrap())).into_response(),
        Err((code, msg)) => {
            let status = if code == "rate_limited" {
                StatusCode::TOO_MANY_REQUESTS
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            (
                status,
                Json(ErrorBody {
                    code: code.to_string(),
                    message: msg.to_string(),
                }),
            )
                .into_response()
        }
    }
}

async fn get_session_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_public_info(&id).await {
        Some(info) => (StatusCode::OK, Json(info)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                code: "not_found".to_string(),
                message: "Session not found or has expired.".to_string(),
            }),
        )
            .into_response(),
    }
}

async fn delete_session_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let token = headers
        .get("x-sender-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    match state.store.end_session(&id, token, "ended_by_sender").await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err("unauthorized") => (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                code: "unauthorized".to_string(),
                message: "Invalid sender token.".to_string(),
            }),
        )
            .into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(ErrorBody {
                code: "not_found".to_string(),
                message: "Session not found.".to_string(),
            }),
        )
            .into_response(),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

enum PeerRole {
    Sender { session_id: String },
    Recipient { session_id: String, recipient_id: String },
}

async fn handle_ws(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerSignal>();

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(text) => {
                    if ws_sender.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(e) => warn!("Failed to serialize signal: {}", e),
            }
        }
    });

    let mut role: Option<PeerRole> = None;
    let mut msg_window_start = Instant::now();
    let mut msg_count_in_window: u32 = 0;

    while let Some(Ok(msg)) = ws_receiver.next().await {
        // Per-connection rate limit: max 80 signalling messages per second
        if msg_window_start.elapsed() >= Duration::from_secs(1) {
            msg_window_start = Instant::now();
            msg_count_in_window = 0;
        }
        msg_count_in_window += 1;
        if msg_count_in_window > 80 {
            let _ = tx.send(ServerSignal::Error {
                code: "rate_limited".to_string(),
                message: "Signalling message rate limit exceeded.".to_string(),
            });
            break;
        }

        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
        };

        // Bound incoming signalling message size (128 KB max for SDP)
        if text.len() > 128 * 1024 {
            let _ = tx.send(ServerSignal::Error {
                code: "payload_too_large".to_string(),
                message: "Signalling message exceeds maximum size.".to_string(),
            });
            break;
        }

        let signal: ClientSignal = match serde_json::from_str(&text) {
            Ok(s) => s,
            Err(_) => {
                let _ = tx.send(ServerSignal::Error {
                    code: "invalid_signal".to_string(),
                    message: "Malformed signalling payload.".to_string(),
                });
                continue;
            }
        };

        match signal {
            ClientSignal::Ping => {
                let _ = tx.send(ServerSignal::Pong);
            }
            ClientSignal::JoinSender {
                session_id,
                sender_token,
            } => {
                if role.is_some() {
                    continue;
                }
                if !is_valid_token_format(&session_id, 12, 32)
                    || !is_valid_token_format(&sender_token, 16, 48)
                {
                    let _ = tx.send(ServerSignal::Error {
                        code: "invalid_token".to_string(),
                        message: "Invalid session or token format.".to_string(),
                    });
                    break;
                }
                match state
                    .store
                    .join_sender(&session_id, &sender_token, tx.clone())
                    .await
                {
                    Ok(()) => {
                        role = Some(PeerRole::Sender { session_id });
                    }
                    Err((code, message)) => {
                        let _ = tx.send(ServerSignal::Error {
                            code: code.to_string(),
                            message: message.to_string(),
                        });
                        break;
                    }
                }
            }
            ClientSignal::JoinRecipient { session_id } => {
                if role.is_some() {
                    continue;
                }
                match state.store.join_recipient(&session_id, tx.clone()).await {
                    Ok(recipient_id) => {
                        role = Some(PeerRole::Recipient {
                            session_id,
                            recipient_id,
                        });
                    }
                    Err((code, message)) => {
                        let _ = tx.send(ServerSignal::Error {
                            code: code.to_string(),
                            message: message.to_string(),
                        });
                        break;
                    }
                }
            }
            ClientSignal::Offer { sdp, recipient_id } => match &role {
                Some(PeerRole::Sender { session_id }) => {
                    let rid = recipient_id.clone().unwrap_or_default();
                    state
                        .store
                        .relay_from_sender(
                            session_id,
                            recipient_id.as_deref(),
                            ServerSignal::Offer {
                                sdp,
                                recipient_id: rid,
                            },
                        )
                        .await;
                }
                Some(PeerRole::Recipient {
                    session_id,
                    recipient_id,
                }) => {
                    state
                        .store
                        .relay_from_recipient(
                            session_id,
                            ServerSignal::Offer {
                                sdp,
                                recipient_id: recipient_id.clone(),
                            },
                        )
                        .await;
                }
                None => {}
            },
            ClientSignal::Answer { sdp, recipient_id } => match &role {
                Some(PeerRole::Sender { session_id }) => {
                    let rid = recipient_id.clone().unwrap_or_default();
                    state
                        .store
                        .relay_from_sender(
                            session_id,
                            recipient_id.as_deref(),
                            ServerSignal::Answer {
                                sdp,
                                recipient_id: rid,
                            },
                        )
                        .await;
                }
                Some(PeerRole::Recipient {
                    session_id,
                    recipient_id,
                }) => {
                    state
                        .store
                        .relay_from_recipient(
                            session_id,
                            ServerSignal::Answer {
                                sdp,
                                recipient_id: recipient_id.clone(),
                            },
                        )
                        .await;
                }
                None => {}
            },
            ClientSignal::IceCandidate {
                candidate,
                recipient_id,
            } => match &role {
                Some(PeerRole::Sender { session_id }) => {
                    let rid = recipient_id.clone().unwrap_or_default();
                    state
                        .store
                        .relay_from_sender(
                            session_id,
                            recipient_id.as_deref(),
                            ServerSignal::IceCandidate {
                                candidate,
                                recipient_id: rid,
                            },
                        )
                        .await;
                }
                Some(PeerRole::Recipient {
                    session_id,
                    recipient_id,
                }) => {
                    state
                        .store
                        .relay_from_recipient(
                            session_id,
                            ServerSignal::IceCandidate {
                                candidate,
                                recipient_id: recipient_id.clone(),
                            },
                        )
                        .await;
                }
                None => {}
            },
            ClientSignal::StatusUpdate { state: new_state } => {
                if let Some(PeerRole::Sender { session_id }) = &role {
                    state.store.update_state(session_id, new_state).await;
                }
            }
        }
    }

    match role {
        Some(PeerRole::Sender { session_id }) => {
            state.store.disconnect_sender(&session_id).await;
            let store_clone = state.store.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(15)).await;
                store_clone.cleanup_sender_if_offline(&session_id).await;
            });
        }
        Some(PeerRole::Recipient {
            session_id,
            recipient_id,
        }) => {
            state
                .store
                .disconnect_recipient(&session_id, &recipient_id)
                .await;
        }
        None => {}
    }

    writer_task.abort();
}
