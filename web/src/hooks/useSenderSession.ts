import { useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  BUFFERED_LOW_THRESHOLD,
  CHUNK_SIZE,
  ConnectionMode,
  DataControlMessage,
  DISK_READ_SIZE,
  encodeChunkFrame,
  ExpiryPolicy,
  FileProgressState,
  MAX_BUFFERED_AMOUNT,
  MAX_CONCURRENT_FILES,
  PROTOCOL_VERSION,
  SessionLifecycle,
} from '../lib/protocol';
import { LocalTransferItem } from '../lib/fileCollector';
import {
  createTransferSession,
  fetchClientConfig,
  revokeTransferSession,
  SignallingClient,
} from '../lib/signalling';
import { detectConnectionMode } from '../lib/rtcStats';

export interface SenderSessionState {
  lifecycle: SessionLifecycle;
  sessionId: string | null;
  senderToken: string | null;
  shareUrl: string | null;
  expiresAtMs: number | null;
  expiryPolicy: ExpiryPolicy;
  hasTurnRelay: boolean;
  connectionMode: ConnectionMode;
  recipientConnected: boolean;
  fileProgress: Record<string, FileProgressState>;
  speedBps: number;
  speedHistory: number[];
  errorMessage: string | null;
}

export function useSenderSession(
  items: LocalTransferItem[],
  label: string,
  expiryPolicy: ExpiryPolicy,
  ttlSeconds: number
) {
  const [state, setState] = useState<SenderSessionState>({
    lifecycle: 'draft',
    sessionId: null,
    senderToken: null,
    shareUrl: null,
    expiresAtMs: null,
    expiryPolicy,
    hasTurnRelay: false,
    connectionMode: 'unknown',
    recipientConnected: false,
    fileProgress: {},
    speedBps: 0,
    speedHistory: [],
    errorMessage: null,
  });

  const itemsRef = useRef<LocalTransferItem[]>(items);
  itemsRef.current = items;

  const labelRef = useRef(label);
  labelRef.current = label;

  const manifestVersionRef = useRef(1);
  const signallingRef = useRef<SignallingClient | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const sessionInfoRef = useRef<{ id: string; token: string } | null>(null);
  const activeRecipientIdRef = useRef<string | null>(null);
  const cancelledFilesRef = useRef<Set<string>>(new Set());
  const streamingQueueRef = useRef<{ fileId: string; startOffset: number }[]>([]);
  const activeWorkersRef = useRef(0);
  const fileSeqCounterRef = useRef(1);
  const bytesSinceSampleRef = useRef(0);
  const lastSampleTsRef = useRef(performance.now());
  const statsTimerRef = useRef<number | null>(null);

  const sendControl = useCallback((msg: DataControlMessage) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(msg));
    }
  }, []);

  const broadcastManifest = useCallback(() => {
    manifestVersionRef.current += 1;
    sendControl({
      v: PROTOCOL_VERSION,
      type: 'manifest',
      version: manifestVersionRef.current,
      label: labelRef.current.trim() || undefined,
      files: itemsRef.current.map((i) => i.meta),
    });
  }, [sendControl]);

  // Live collection update when items change while session is active
  useEffect(() => {
    if (
      dcRef.current?.readyState === 'open' &&
      (state.lifecycle === 'waiting' ||
        state.lifecycle === 'connecting' ||
        state.lifecycle === 'transferring' ||
        state.lifecycle === 'completed')
    ) {
      broadcastManifest();
    }
  }, [items, broadcastManifest, state.lifecycle]);

  const cleanupPeer = useCallback(() => {
    if (statsTimerRef.current !== null) {
      window.clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    activeWorkersRef.current = 0;
    streamingQueueRef.current = [];
    bytesSinceSampleRef.current = 0;
    cancelledFilesRef.current.clear();
  }, []);

  const resetInflightProgress = useCallback(() => {
    setState((prev) => {
      const next: Record<string, FileProgressState> = {};
      for (const [id, p] of Object.entries(prev.fileProgress)) {
        if (p.status === 'verified') {
          next[id] = p;
        }
      }
      return {
        ...prev,
        fileProgress: next,
        speedBps: 0,
      };
    });
  }, []);

  const waitForBufferDrain = (dc: RTCDataChannel): Promise<void> => {
    if (dc.bufferedAmount <= MAX_BUFFERED_AMOUNT) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const onLow = () => {
        dc.removeEventListener('bufferedamountlow', onLow);
        resolve();
      };
      dc.addEventListener('bufferedamountlow', onLow);
      // Safety fallback poll in case event is missed
      const check = window.setInterval(() => {
        if (dc.readyState !== 'open' || dc.bufferedAmount <= BUFFERED_LOW_THRESHOLD) {
          window.clearInterval(check);
          dc.removeEventListener('bufferedamountlow', onLow);
          resolve();
        }
      }, 40);
    });
  };

  const streamSingleFile = useCallback(
    async (req: { fileId: string; startOffset: number }) => {
      const dc = dcRef.current;
      if (!dc || dc.readyState !== 'open') return;
      if (cancelledFilesRef.current.has(req.fileId)) {
        cancelledFilesRef.current.delete(req.fileId);
        return;
      }

      const item = itemsRef.current.find((i) => i.meta.id === req.fileId);
      if (!item) return;

      const fileSeq = fileSeqCounterRef.current++;
      const file = item.file;
      const startOffset = Math.max(0, Math.min(req.startOffset, file.size));

      setState((prev) => ({
        ...prev,
        lifecycle: 'transferring',
        fileProgress: {
          ...prev.fileProgress,
          [req.fileId]: {
            fileId: req.fileId,
            bytesTransferred: startOffset,
            totalBytes: file.size,
            status: 'transferring',
          },
        },
      }));

      signallingRef.current?.send({
        type: 'status_update',
        state: 'transferring',
      });

      sendControl({
        v: PROTOCOL_VERSION,
        type: 'file_start',
        fileId: req.fileId,
        fileSeq,
        startOffset,
        size: file.size,
      });

      const hasher = sha256.create();
      if (startOffset > 0) {
        let hashPos = 0;
        while (hashPos < startOffset) {
          const end = Math.min(hashPos + DISK_READ_SIZE, startOffset);
          const buf = await file.slice(hashPos, end).arrayBuffer();
          hasher.update(new Uint8Array(buf));
          hashPos = end;
        }
      }

      let offset = startOffset;
      let lastUiUpdate = performance.now();

      while (offset < file.size) {
        if (!dcRef.current || dcRef.current.readyState !== 'open') {
          throw new Error('Data channel closed during transfer');
        }
        if (cancelledFilesRef.current.has(req.fileId)) {
          cancelledFilesRef.current.delete(req.fileId);
          sendControl({
            v: PROTOCOL_VERSION,
            type: 'file_cancel',
            fileId: req.fileId,
          });
          setState((prev) => ({
            ...prev,
            fileProgress: {
              ...prev.fileProgress,
              [req.fileId]: {
                fileId: req.fileId,
                bytesTransferred: offset,
                totalBytes: file.size,
                status: 'cancelled',
              },
            },
          }));
          return;
        }

        // Read a 2 MB batch from disk in one async call, then frame into 64 KB chunks
        const batchEnd = Math.min(offset + DISK_READ_SIZE, file.size);
        const batchBuf = await file.slice(offset, batchEnd).arrayBuffer();
        const batchBytes = new Uint8Array(batchBuf);
        hasher.update(batchBytes);

        let batchPos = 0;
        while (batchPos < batchBytes.byteLength) {
          if (!dcRef.current || dcRef.current.readyState !== 'open') {
            throw new Error('Data channel closed during transfer');
          }
          if (cancelledFilesRef.current.has(req.fileId)) break;

          await waitForBufferDrain(dc);

          const chunkEnd = Math.min(batchPos + CHUNK_SIZE, batchBytes.byteLength);
          const chunk = batchBytes.subarray(batchPos, chunkEnd);
          const frame = encodeChunkFrame(fileSeq, offset + batchPos, chunk);
          dc.send(frame);

          batchPos = chunkEnd;
          bytesSinceSampleRef.current += chunk.byteLength;

          const now = performance.now();
          if (now - lastUiUpdate >= 80) {
            lastUiUpdate = now;
            const currentSent = offset + batchPos;
            setState((prev) => ({
              ...prev,
              fileProgress: {
                ...prev.fileProgress,
                [req.fileId]: {
                  fileId: req.fileId,
                  bytesTransferred: currentSent,
                  totalBytes: file.size,
                  status: 'transferring',
                },
              },
            }));
          }
        }

        offset = batchEnd;
      }

      if (offset === file.size && !cancelledFilesRef.current.has(req.fileId)) {
        setState((prev) => ({
          ...prev,
          fileProgress: {
            ...prev.fileProgress,
            [req.fileId]: {
              fileId: req.fileId,
              bytesTransferred: file.size,
              totalBytes: file.size,
              status: 'verifying',
            },
          },
        }));
        const digest = bytesToHex(hasher.digest());
        sendControl({
          v: PROTOCOL_VERSION,
          type: 'file_eof',
          fileId: req.fileId,
          fileSeq,
          sha256: digest,
          totalBytes: file.size,
        });
      }
    },
    [sendControl]
  );

  const processStreamQueue = useCallback(() => {
    const runWorker = async () => {
      activeWorkersRef.current += 1;
      try {
        while (streamingQueueRef.current.length > 0) {
          const dc = dcRef.current;
          if (!dc || dc.readyState !== 'open') break;
          const req = streamingQueueRef.current.shift();
          if (!req) break;
          await streamSingleFile(req);
        }
      } catch (err) {
        console.error('Streaming error:', err);
      } finally {
        activeWorkersRef.current -= 1;
      }
    };

    const needed = Math.min(
      MAX_CONCURRENT_FILES - activeWorkersRef.current,
      streamingQueueRef.current.length
    );
    for (let i = 0; i < needed; i++) {
      runWorker();
    }
  }, [streamSingleFile]);

  const setupPeerForRecipient = useCallback(
    async (recipientId: string, iceServers: RTCIceServer[]) => {
      cleanupPeer();
      activeRecipientIdRef.current = recipientId;

      const pc = new RTCPeerConnection({ iceServers });
      pcRef.current = pc;

      const dc = pc.createDataChannel('ferry-transfer', { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD;
      dcRef.current = dc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signallingRef.current?.send({
            type: 'ice_candidate',
            candidate: event.candidate.toJSON(),
            recipient_id: recipientId,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          detectConnectionMode(pc).then((mode) => {
            setState((prev) => ({ ...prev, connectionMode: mode }));
          });
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setState((prev) => ({
            ...prev,
            recipientConnected: false,
            connectionMode: 'unknown',
          }));
        }
      };

      dc.onopen = () => {
        setState((prev) => ({
          ...prev,
          recipientConnected: true,
          lifecycle: prev.lifecycle === 'waiting' || prev.lifecycle === 'connecting'
            ? 'connecting'
            : prev.lifecycle,
        }));

        sendControl({
          v: PROTOCOL_VERSION,
          type: 'hello',
          role: 'sender',
          capabilities: { directoryPicker: false },
        });
        broadcastManifest();

        detectConnectionMode(pc).then((mode) => {
          setState((prev) => ({ ...prev, connectionMode: mode }));
        });

        lastSampleTsRef.current = performance.now();
        bytesSinceSampleRef.current = 0;
        statsTimerRef.current = window.setInterval(() => {
          const now = performance.now();
          const dt = Math.max(0.1, (now - lastSampleTsRef.current) / 1000);
          const instantBps = bytesSinceSampleRef.current / dt;
          bytesSinceSampleRef.current = 0;
          lastSampleTsRef.current = now;
          setState((prev) => {
            const smoothed =
              prev.speedBps > 0
                ? prev.speedBps * 0.65 + instantBps * 0.35
                : instantBps;
            return {
              ...prev,
              speedBps: smoothed,
              speedHistory: [...prev.speedHistory.slice(-29), smoothed],
            };
          });
        }, 500);
      };

      dc.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const msg = JSON.parse(event.data) as DataControlMessage;
          if (msg.type === 'request_files') {
            streamingQueueRef.current.push(...msg.requests);
            processStreamQueue();
          } else if (msg.type === 'file_cancel') {
            cancelledFilesRef.current.add(msg.fileId);
          } else if (msg.type === 'file_ack') {
            setState((prev) => {
              const existing = prev.fileProgress[msg.fileId];
              return {
                ...prev,
                fileProgress: {
                  ...prev.fileProgress,
                  [msg.fileId]: {
                    fileId: msg.fileId,
                    bytesTransferred: msg.receivedBytes,
                    totalBytes: existing?.totalBytes ?? msg.receivedBytes,
                    status: msg.status === 'verified' ? 'verified' : 'hash_mismatch',
                    error: msg.message,
                  },
                },
              };
            });
          } else if (msg.type === 'transfer_complete') {
            setState((prev) => ({
              ...prev,
              lifecycle: 'completed',
              speedBps: 0,
            }));
            signallingRef.current?.send({
              type: 'status_update',
              state: 'completed',
            });
            if (expiryPolicy === 'after_download' && sessionInfoRef.current) {
              // Give recipient a brief moment to finalize UI before closing signalling
              const { id, token } = sessionInfoRef.current;
              window.setTimeout(() => {
                revokeTransferSession(id, token).catch(() => {});
              }, 3000);
            }
          }
        } catch {
          // Ignore malformed control message
        }
      };

      dc.onclose = () => {
        resetInflightProgress();
        setState((prev) => ({
          ...prev,
          recipientConnected: false,
          speedBps: 0,
          lifecycle: prev.lifecycle === 'completed' ? 'completed' : 'waiting',
        }));
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signallingRef.current?.send({
        type: 'offer',
        sdp: offer.sdp,
        recipient_id: recipientId,
      });
    },
    [broadcastManifest, cleanupPeer, expiryPolicy, processStreamQueue, sendControl]
  );

  const startSession = useCallback(async () => {
    if (itemsRef.current.length === 0) return;

    setState((prev) => ({
      ...prev,
      lifecycle: 'creating',
      errorMessage: null,
      fileProgress: {},
      speedBps: 0,
      speedHistory: [],
    }));

    try {
      const [config, created] = await Promise.all([
        fetchClientConfig(),
        createTransferSession({
          expiryPolicy,
          ttlSeconds,
          label: labelRef.current.trim() || undefined,
        }),
      ]);

      sessionInfoRef.current = {
        id: created.session_id,
        token: created.sender_token,
      };

      const shareUrl = `${window.location.origin}/?s=${created.session_id}`;

      const signalClient = new SignallingClient(
        async (signal) => {
          if (signal.type === 'joined') {
            setState((prev) => ({
              ...prev,
              lifecycle: 'waiting',
              sessionId: created.session_id,
              senderToken: created.sender_token,
              shareUrl,
              expiresAtMs: created.expires_at_ms,
              expiryPolicy: created.expiry_policy,
              hasTurnRelay: config.has_turn_relay,
            }));
          } else if (signal.type === 'peer_joined') {
            if (
              activeRecipientIdRef.current === signal.recipient_id &&
              dcRef.current &&
              (dcRef.current.readyState === 'open' || dcRef.current.readyState === 'connecting')
            ) {
              return;
            }
            setState((prev) => ({ ...prev, lifecycle: 'connecting' }));
            await setupPeerForRecipient(signal.recipient_id, config.ice_servers);
          } else if (signal.type === 'peer_left') {
            cleanupPeer();
            resetInflightProgress();
            setState((prev) => ({
              ...prev,
              recipientConnected: false,
              connectionMode: 'unknown',
              lifecycle: prev.lifecycle === 'completed' ? 'completed' : 'waiting',
            }));
          } else if (signal.type === 'answer' && pcRef.current) {
            await pcRef.current.setRemoteDescription({
              type: 'answer',
              sdp: signal.sdp,
            });
          } else if (signal.type === 'ice_candidate' && pcRef.current) {
            await pcRef.current.addIceCandidate(signal.candidate).catch(() => {});
          } else if (signal.type === 'session_ended') {
            cleanupPeer();
            setState((prev) => ({
              ...prev,
              lifecycle: 'ended',
              recipientConnected: false,
            }));
          } else if (signal.type === 'error') {
            setState((prev) => ({
              ...prev,
              lifecycle: 'failed',
              errorMessage: signal.message,
            }));
          }
        },
        () => {
          cleanupPeer();
          setState((prev) => {
            if (prev.lifecycle === 'ended' || prev.lifecycle === 'draft') return prev;
            return {
              ...prev,
              lifecycle: 'ended',
              recipientConnected: false,
            };
          });
        }
      );

      signallingRef.current = signalClient;
      await signalClient.connect();
      signalClient.send({
        type: 'join_sender',
        session_id: created.session_id,
        sender_token: created.sender_token,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        lifecycle: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Failed to start transfer session',
      }));
    }
  }, [cleanupPeer, expiryPolicy, setupPeerForRecipient, ttlSeconds]);

  const endSession = useCallback(async () => {
    const info = sessionInfoRef.current;
    sessionInfoRef.current = null;
    cleanupPeer();
    signallingRef.current?.close();
    signallingRef.current = null;
    if (info) {
      await revokeTransferSession(info.id, info.token).catch(() => {});
    }
    setState((prev) => ({
      ...prev,
      lifecycle: 'draft',
      sessionId: null,
      senderToken: null,
      shareUrl: null,
      recipientConnected: false,
      connectionMode: 'unknown',
      speedBps: 0,
      speedHistory: [],
    }));
  }, [cleanupPeer]);

  const cancelFile = useCallback((fileId: string) => {
    cancelledFilesRef.current.add(fileId);
  }, []);

  useEffect(() => {
    return () => {
      const info = sessionInfoRef.current;
      if (info) {
        revokeTransferSession(info.id, info.token).catch(() => {});
      }
      cleanupPeer();
      signallingRef.current?.close();
    };
  }, [cleanupPeer]);

  return {
    state,
    startSession,
    endSession,
    cancelFile,
  };
}
