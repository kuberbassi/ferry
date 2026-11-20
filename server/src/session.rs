use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{mpsc, RwLock};

pub const MAX_SESSIONS_PER_IP: usize = 12;
pub const MAX_GLOBAL_SESSIONS: usize = 2_000;
pub const DEFAULT_TTL_SECS: u64 = 3_600; // 1 hour
pub const MAX_TTL_SECS: u64 = 86_400; // 24 hours
pub const MIN_TTL_SECS: u64 = 60; // 1 minute

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExpiryPolicy {
    Manual,
    Duration,
    AfterDownload,
    Inactivity,
}

impl Default for ExpiryPolicy {
    fn default() -> Self {
        Self::Duration
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Waiting,
    Connecting,
    Transferring,
    Completed,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientSignal {
    JoinSender {
        session_id: String,
        sender_token: String,
    },
    JoinRecipient {
        session_id: String,
    },
    Offer {
        sdp: String,
        #[serde(default)]
        recipient_id: Option<String>,
    },
    Answer {
        sdp: String,
        #[serde(default)]
        recipient_id: Option<String>,
    },
    IceCandidate {
        candidate: serde_json::Value,
        #[serde(default)]
        recipient_id: Option<String>,
    },
    StatusUpdate {
        state: SessionState,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerSignal {
    Joined {
        role: String,
        session_id: String,
        recipient_id: Option<String>,
        sender_online: bool,
    },
    PeerJoined {
        role: String,
        recipient_id: String,
    },
    PeerLeft {
        role: String,
        recipient_id: Option<String>,
    },
    Offer {
        sdp: String,
        recipient_id: String,
    },
    Answer {
        sdp: String,
        recipient_id: String,
    },
    IceCandidate {
        candidate: serde_json::Value,
        recipient_id: String,
    },
    SessionEnded {
        reason: String,
    },
    Error {
        code: String,
        message: String,
    },
    Pong,
}

pub type SignalTx = mpsc::UnboundedSender<ServerSignal>;

#[derive(Debug)]
pub struct Session {
    pub id: String,
    pub sender_token: String,
    pub label: Option<String>,
    pub expiry_policy: ExpiryPolicy,
    pub state: SessionState,
    pub created_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub last_activity_ms: u64,
    pub creator_ip: Option<IpAddr>,
    pub sender_tx: Option<SignalTx>,
    pub recipients: HashMap<String, SignalTx>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicSessionInfo {
    pub session_id: String,
    pub label: Option<String>,
    pub expiry_policy: ExpiryPolicy,
    pub state: SessionState,
    pub expires_at_ms: Option<u64>,
    pub sender_online: bool,
    pub recipient_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateSessionResponse {
    pub session_id: String,
    pub sender_token: String,
    pub expiry_policy: ExpiryPolicy,
    pub expires_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct SessionStore {
    inner: Arc<RwLock<HashMap<String, Session>>>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn active_count(&self) -> usize {
        self.inner.read().await.len()
    }

    pub async fn create_session(
        &self,
        expiry_policy: ExpiryPolicy,
        ttl_seconds: Option<u64>,
        label: Option<String>,
        creator_ip: Option<IpAddr>,
    ) -> Result<CreateSessionResponse, (&'static str, &'static str)> {
        let mut guard = self.inner.write().await;
        if guard.len() >= MAX_GLOBAL_SESSIONS {
            return Err(("capacity_exceeded", "Signalling server is at capacity. Try again shortly."));
        }

        if let Some(ip) = creator_ip {
            let ip_count = guard.values().filter(|s| s.creator_ip == Some(ip)).count();
            if ip_count >= MAX_SESSIONS_PER_IP {
                return Err((
                    "rate_limited",
                    "Too many active sessions from this address. Close an existing session first.",
                ));
            }
        }

        let now = now_ms();
        let ttl = ttl_seconds
            .unwrap_or(DEFAULT_TTL_SECS)
            .clamp(MIN_TTL_SECS, MAX_TTL_SECS);

        let expires_at_ms = match expiry_policy {
            ExpiryPolicy::Manual => Some(now + MAX_TTL_SECS * 1000),
            ExpiryPolicy::Duration | ExpiryPolicy::Inactivity | ExpiryPolicy::AfterDownload => {
                Some(now + ttl * 1000)
            }
        };

        let id = generate_token(16);
        let sender_token = generate_token(24);
        let sanitized_label = label
            .map(|l| l.trim().chars().take(80).collect::<String>())
            .filter(|l| !l.is_empty());

        let session = Session {
            id: id.clone(),
            sender_token: sender_token.clone(),
            label: sanitized_label,
            expiry_policy,
            state: SessionState::Waiting,
            created_at_ms: now,
            expires_at_ms,
            last_activity_ms: now,
            creator_ip,
            sender_tx: None,
            recipients: HashMap::new(),
        };

        guard.insert(id.clone(), session);

        Ok(CreateSessionResponse {
            session_id: id,
            sender_token,
            expiry_policy,
            expires_at_ms,
        })
    }

    pub async fn get_public_info(&self, session_id: &str) -> Option<PublicSessionInfo> {
        let guard = self.inner.read().await;
        let s = guard.get(session_id)?;
        if is_expired(s, now_ms()) {
            return None;
        }
        Some(PublicSessionInfo {
            session_id: s.id.clone(),
            label: s.label.clone(),
            expiry_policy: s.expiry_policy,
            state: s.state,
            expires_at_ms: s.expires_at_ms,
            sender_online: s.sender_tx.is_some(),
            recipient_count: s.recipients.len(),
        })
    }

    pub async fn end_session(
        &self,
        session_id: &str,
        sender_token: &str,
        reason: &str,
    ) -> Result<(), &'static str> {
        let mut guard = self.inner.write().await;
        let Some(session) = guard.get(session_id) else {
            return Err("not_found");
        };
        if !constant_time_eq(&session.sender_token, sender_token) {
            return Err("unauthorized");
        }
        if let Some(removed) = guard.remove(session_id) {
            notify_session_ended(removed, reason);
        }
        Ok(())
    }

    pub async fn join_sender(
        &self,
        session_id: &str,
        sender_token: &str,
        tx: SignalTx,
    ) -> Result<(), (&'static str, &'static str)> {
        let mut guard = self.inner.write().await;
        let Some(session) = guard.get_mut(session_id) else {
            return Err(("not_found", "Transfer session does not exist or has expired."));
        };
        if is_expired(session, now_ms()) {
            if let Some(removed) = guard.remove(session_id) {
                notify_session_ended(removed, "expired");
            }
            return Err(("expired", "Transfer session has expired."));
        }
        if !constant_time_eq(&session.sender_token, sender_token) {
            return Err(("unauthorized", "Invalid sender token for this session."));
        }

        session.sender_tx = Some(tx.clone());
        session.last_activity_ms = now_ms();

        let _ = tx.send(ServerSignal::Joined {
            role: "sender".to_string(),
            session_id: session.id.clone(),
            recipient_id: None,
            sender_online: true,
        });

        for recipient_id in session.recipients.keys() {
            let _ = tx.send(ServerSignal::PeerJoined {
                role: "recipient".to_string(),
                recipient_id: recipient_id.clone(),
            });
        }

        Ok(())
    }

    pub async fn join_recipient(
        &self,
        session_id: &str,
        tx: SignalTx,
    ) -> Result<String, (&'static str, &'static str)> {
        let mut guard = self.inner.write().await;
        let Some(session) = guard.get_mut(session_id) else {
            return Err(("not_found", "Transfer session does not exist or has ended."));
        };
        if is_expired(session, now_ms()) {
            if let Some(removed) = guard.remove(session_id) {
                notify_session_ended(removed, "expired");
            }
            return Err(("expired", "Transfer session has expired."));
        }
        if session.sender_tx.is_none() {
            return Err((
                "sender_offline",
                "The sender is not currently online for this transfer.",
            ));
        }

        // MVP supports 1 active recipient cleanly, or multiple queued; cap to 4 to prevent abuse.
        if session.recipients.len() >= 4 {
            return Err((
                "session_full",
                "This transfer already has the maximum number of connected recipients.",
            ));
        }

        let recipient_id = generate_token(8);
        session.recipients.insert(recipient_id.clone(), tx.clone());
        session.last_activity_ms = now_ms();
        session.state = SessionState::Connecting;

        let _ = tx.send(ServerSignal::Joined {
            role: "recipient".to_string(),
            session_id: session.id.clone(),
            recipient_id: Some(recipient_id.clone()),
            sender_online: true,
        });

        if let Some(sender_tx) = &session.sender_tx {
            let _ = sender_tx.send(ServerSignal::PeerJoined {
                role: "recipient".to_string(),
                recipient_id: recipient_id.clone(),
            });
        }

        Ok(recipient_id)
    }

    pub async fn relay_from_sender(
        &self,
        session_id: &str,
        recipient_id: Option<&str>,
        signal: ServerSignal,
    ) {
        let mut guard = self.inner.write().await;
        let Some(session) = guard.get_mut(session_id) else {
            return;
        };
        session.last_activity_ms = now_ms();

        if let Some(rid) = recipient_id {
            if let Some(r_tx) = session.recipients.get(rid) {
                let _ = r_tx.send(signal);
            }
        } else if let Some(r_tx) = session.recipients.values().next() {
            let _ = r_tx.send(signal);
        }
    }

    pub async fn relay_from_recipient(
        &self,
        session_id: &str,
        signal: ServerSignal,
    ) {
        let mut guard = self.inner.write().await;
        let Some(session) = guard.get_mut(session_id) else {
            return;
        };
        session.last_activity_ms = now_ms();

        if let Some(sender_tx) = &session.sender_tx {
            let _ = sender_tx.send(signal);
        }
    }

    pub async fn update_state(&self, session_id: &str, state: SessionState) {
        let mut guard = self.inner.write().await;
        if let Some(session) = guard.get_mut(session_id) {
            session.state = state;
            session.last_activity_ms = now_ms();
        }
    }

    pub async fn disconnect_sender(&self, session_id: &str) {
        let mut guard = self.inner.write().await;
        if let Some(removed) = guard.remove(session_id) {
            notify_session_ended(removed, "sender_disconnected");
        }
    }

    pub async fn disconnect_recipient(&self, session_id: &str, recipient_id: &str) {
        let mut guard = self.inner.write().await;
        if let Some(session) = guard.get_mut(session_id) {
            session.recipients.remove(recipient_id);
            session.last_activity_ms = now_ms();
            if session.recipients.is_empty() && session.state != SessionState::Completed {
                session.state = SessionState::Waiting;
            }
            if let Some(sender_tx) = &session.sender_tx {
                let _ = sender_tx.send(ServerSignal::PeerLeft {
                    role: "recipient".to_string(),
                    recipient_id: Some(recipient_id.to_string()),
                });
            }
        }
    }

    pub async fn reap_expired(&self) -> usize {
        let now = now_ms();
        let mut guard = self.inner.write().await;
        let expired_ids: Vec<String> = guard
            .iter()
            .filter(|(_, s)| is_expired(s, now))
            .map(|(id, _)| id.clone())
            .collect();

        let count = expired_ids.len();
        for id in expired_ids {
            if let Some(removed) = guard.remove(&id) {
                notify_session_ended(removed, "expired");
            }
        }
        count
    }
}

fn notify_session_ended(session: Session, reason: &str) {
    let msg = ServerSignal::SessionEnded {
        reason: reason.to_string(),
    };
    if let Some(sender_tx) = session.sender_tx {
        let _ = sender_tx.send(msg.clone());
    }
    for (_, r_tx) in session.recipients {
        let _ = r_tx.send(msg.clone());
    }
}

fn is_expired(session: &Session, now: u64) -> bool {
    if session.state == SessionState::Transferring {
        return false;
    }
    if let Some(exp) = session.expires_at_ms {
        if now >= exp {
            return true;
        }
    }
    if session.expiry_policy == ExpiryPolicy::Inactivity
        && now.saturating_sub(session.last_activity_ms) >= 15 * 60 * 1000
    {
        return true;
    }
    false
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn generate_token(byte_len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
    let mut rng = rand::rng();
    let mut out = String::with_capacity(byte_len);
    for _ in 0..byte_len {
        let idx = rng.random_range(0..ALPHABET.len());
        out.push(ALPHABET[idx] as char);
    }
    out
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[tokio::test]
    async fn create_and_end_session_enforces_token() {
        let store = SessionStore::new();
        let created = store
            .create_session(ExpiryPolicy::Duration, Some(600), Some("Build Artifacts".into()), None)
            .await
            .expect("session created");

        assert_eq!(created.session_id.len(), 16);
        assert_eq!(created.sender_token.len(), 24);
        assert!(store.get_public_info(&created.session_id).await.is_some());

        // Wrong token fails
        let err = store
            .end_session(&created.session_id, "wrong_token", "manual")
            .await
            .unwrap_err();
        assert_eq!(err, "unauthorized");

        // Correct token removes session
        store
            .end_session(&created.session_id, &created.sender_token, "manual")
            .await
            .expect("ended");
        assert!(store.get_public_info(&created.session_id).await.is_none());
    }

    #[tokio::test]
    async fn rate_limits_per_ip() {
        let store = SessionStore::new();
        let ip = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1));
        for _ in 0..MAX_SESSIONS_PER_IP {
            store
                .create_session(ExpiryPolicy::Manual, None, None, Some(ip))
                .await
                .expect("within limit");
        }
        let err = store
            .create_session(ExpiryPolicy::Manual, None, None, Some(ip))
            .await
            .unwrap_err();
        assert_eq!(err.0, "rate_limited");
    }

    #[tokio::test]
    async fn sender_disconnect_notifies_recipient_and_cleans_up() {
        let store = SessionStore::new();
        let created = store
            .create_session(ExpiryPolicy::Duration, Some(300), None, None)
            .await
            .unwrap();

        let (s_tx, mut s_rx) = mpsc::unbounded_channel();
        store
            .join_sender(&created.session_id, &created.sender_token, s_tx)
            .await
            .unwrap();

        let (r_tx, mut r_rx) = mpsc::unbounded_channel();
        let rid = store
            .join_recipient(&created.session_id, r_tx)
            .await
            .unwrap();

        // Sender received Joined + PeerJoined
        assert!(matches!(s_rx.recv().await, Some(ServerSignal::Joined { .. })));
        assert!(matches!(
            s_rx.recv().await,
            Some(ServerSignal::PeerJoined { recipient_id, .. }) if recipient_id == rid
        ));

        // Recipient received Joined
        assert!(matches!(r_rx.recv().await, Some(ServerSignal::Joined { .. })));

        // Sender disconnects
        store.disconnect_sender(&created.session_id).await;
        assert!(matches!(
            r_rx.recv().await,
            Some(ServerSignal::SessionEnded { reason }) if reason == "sender_disconnected"
        ));
        assert!(store.get_public_info(&created.session_id).await.is_none());
    }
}
