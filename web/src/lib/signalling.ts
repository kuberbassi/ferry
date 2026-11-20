import { ExpiryPolicy } from './protocol';

export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface ClientConfigResponse {
  ice_servers: IceServerConfig[];
  default_ttl_seconds: number;
  max_ttl_seconds: number;
  has_turn_relay: boolean;
}

export interface CreateSessionResponse {
  session_id: string;
  sender_token: string;
  expiry_policy: ExpiryPolicy;
  expires_at_ms: number | null;
}

export interface PublicSessionInfo {
  session_id: string;
  label: string | null;
  expiry_policy: ExpiryPolicy;
  state: string;
  expires_at_ms: number | null;
  sender_online: boolean;
  recipient_count: number;
}

export type ServerSignal =
  | {
      type: 'joined';
      role: 'sender' | 'recipient';
      session_id: string;
      recipient_id: string | null;
      sender_online: boolean;
    }
  | {
      type: 'peer_joined';
      role: 'recipient';
      recipient_id: string;
    }
  | {
      type: 'peer_left';
      role: 'recipient';
      recipient_id: string | null;
    }
  | {
      type: 'offer';
      sdp: string;
      recipient_id: string;
    }
  | {
      type: 'answer';
      sdp: string;
      recipient_id: string;
    }
  | {
      type: 'ice_candidate';
      candidate: RTCIceCandidateInit;
      recipient_id: string;
    }
  | {
      type: 'session_ended';
      reason: string;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    }
  | {
      type: 'pong';
    };

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || '';

export async function fetchClientConfig(): Promise<ClientConfigResponse> {
  const res = await fetch(`${API_BASE}/api/config`);
  if (!res.ok) {
    throw new Error('Failed to load Ferry configuration');
  }
  return res.json();
}

export async function createTransferSession(params: {
  expiryPolicy: ExpiryPolicy;
  ttlSeconds?: number;
  label?: string;
}): Promise<CreateSessionResponse> {
  const res = await fetch(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expiry_policy: params.expiryPolicy,
      ttl_seconds: params.ttlSeconds,
      label: params.label,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: 'Could not create transfer session' }));
    throw new Error(err.message || 'Could not create transfer session');
  }
  return res.json();
}

export async function fetchPublicSession(sessionId: string): Promise<PublicSessionInfo> {
  const res = await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: 'Session not found or expired' }));
    throw new Error(err.message || 'Session not found or expired');
  }
  return res.json();
}

export async function revokeTransferSession(
  sessionId: string,
  senderToken: string
): Promise<void> {
  await fetch(`${API_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    headers: {
      'x-sender-token': senderToken,
    },
  });
}

export function getWebSocketUrl(): string {
  const envWs = import.meta.env.VITE_WS_BASE as string | undefined;
  if (envWs && envWs.trim().length > 0) {
    return `${envWs.replace(/\/$/, '')}/ws`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export class SignallingClient {
  private ws: WebSocket | null = null;
  private pingTimer: number | null = null;
  private onSignal: (signal: ServerSignal) => void;
  private onClose: () => void;

  constructor(onSignal: (signal: ServerSignal) => void, onClose: () => void) {
    this.onSignal = onSignal;
    this.onClose = onClose;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(getWebSocketUrl());
      this.ws = ws;

      ws.onopen = () => {
        this.pingTimer = window.setInterval(() => {
          this.send({ type: 'ping' });
        }, 20_000);
        resolve();
      };

      ws.onerror = () => {
        reject(new Error('Could not connect to Ferry signalling service'));
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as ServerSignal;
          this.onSignal(parsed);
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        this.cleanupTimers();
        this.onClose();
      };
    });
  }

  send(payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  close(): void {
    this.cleanupTimers();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private cleanupTimers(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
