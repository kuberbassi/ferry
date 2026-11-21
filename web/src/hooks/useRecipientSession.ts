import { useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  ACK_INTERVAL_BYTES,
  ConnectionMode,
  DataControlMessage,
  decodeChunkFrame,
  FileProgressState,
  PROTOCOL_VERSION,
  sanitizeRelativePath,
  SessionLifecycle,
  TransferFile,
} from '../lib/protocol';
import {
  fetchClientConfig,
  fetchPublicSession,
  PublicSessionInfo,
  SignallingClient,
} from '../lib/signalling';
import { detectConnectionMode } from '../lib/rtcStats';
import { createBgInterval } from '../lib/bgTimer';
import {
  clearResumeFile,
  getResumeMeta,
  purgeExpiredResumeData,
  readResumeBlocks,
  saveResumeBlock,
} from '../lib/resumeStore';

interface IncomingFileWriter {
  fileId: string;
  meta: TransferFile;
  hasher: ReturnType<typeof sha256.create>;
  receivedBytes: number;
  resumedFromBytes: number;
  pendingBlockChunks: Uint8Array[];
  pendingBlockBytes: number;
  nextBlockIdx: number;
  chunks: BlobPart[];
  writable: FileSystemWritableFileStream | null;
}

export interface RecipientSessionState {
  lifecycle: SessionLifecycle;
  sessionInfo: PublicSessionInfo | null;
  manifestLabel: string | null;
  files: TransferFile[];
  newlyAddedIds: string[];
  connectionMode: ConnectionMode;
  fileProgress: Record<string, FileProgressState>;
  speedBps: number;
  speedHistory: number[];
  errorMessage: string | null;
  directoryMode: boolean;
}

export function useRecipientSession(sessionId: string) {
  const [state, setState] = useState<RecipientSessionState>({
    lifecycle: 'connecting',
    sessionInfo: null,
    manifestLabel: null,
    files: [],
    newlyAddedIds: [],
    connectionMode: 'unknown',
    fileProgress: {},
    speedBps: 0,
    speedHistory: [],
    errorMessage: null,
    directoryMode: false,
  });

  const signallingRef = useRef<SignallingClient | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const filesRef = useRef<TransferFile[]>([]);
  const seqToFileIdRef = useRef<Map<number, string>>(new Map());
  const writersRef = useRef<Map<string, IncomingFileWriter>>(new Map());
  const dirHandleRef = useRef<FileSystemDirectoryHandle | null>(null);
  const requestedIdsRef = useRef<string[]>([]);
  const completedIdsRef = useRef<Set<string>>(new Set());
  const endedBySenderRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const bytesSinceSampleRef = useRef(0);
  const lastSampleTsRef = useRef(performance.now());
  const lastProgressUiRef = useRef(0);
  const stopStatsTimerRef = useRef<(() => void) | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  const sendControl = useCallback((msg: DataControlMessage) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(msg));
    }
  }, []);

  const abortAllWriters = useCallback(() => {
    for (const writer of writersRef.current.values()) {
      writer.chunks = [];
      if (writer.writable) {
        writer.writable.abort().catch(() => {});
      }
    }
    writersRef.current.clear();
  }, []);

  const triggerBlobDownload = (meta: TransferFile, chunks: BlobPart[]) => {
    const blob = new Blob(chunks, { type: meta.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const openDirectoryWritable = async (
    rootDir: FileSystemDirectoryHandle,
    relativePath: string
  ): Promise<FileSystemWritableFileStream> => {
    const safePath = sanitizeRelativePath(relativePath, 'file');
    const parts = safePath.split('/');
    const fileName = parts.pop()!;
    let currentDir = rootDir;
    for (const folder of parts) {
      currentDir = await currentDir.getDirectoryHandle(folder, { create: true });
    }
    const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
    return fileHandle.createWritable();
  };

  const finalizeFile = useCallback(
    async (fileId: string, expectedSha256: string, expectedTotal: number) => {
      const writer = writersRef.current.get(fileId);
      if (!writer) return;

      let fullChunks: BlobPart[] = writer.chunks;
      let actualSha256: string;

      if (writer.resumedFromBytes > 0 && !writer.writable) {
        // Reconstruct full file from IndexedDB retained blocks + newly received chunks
        const retainedBlocks = await readResumeBlocks(sessionId, fileId);
        const fullHasher = sha256.create();
        for (const block of retainedBlocks) {
          fullHasher.update(block);
        }
        for (const chunk of writer.chunks) {
          if (chunk instanceof Uint8Array) {
            fullHasher.update(chunk);
          }
        }
        actualSha256 = bytesToHex(fullHasher.digest());
        fullChunks = [...(retainedBlocks as BlobPart[]), ...writer.chunks];
      } else {
        actualSha256 = bytesToHex(writer.hasher.digest());
      }

      const matches = actualSha256 === expectedSha256 && writer.receivedBytes === expectedTotal;

      if (writer.writable) {
        await writer.writable.close();
      } else if (matches) {
        triggerBlobDownload(writer.meta, fullChunks);
      }

      writer.chunks = [];
      writer.pendingBlockChunks = [];
      writersRef.current.delete(fileId);
      await clearResumeFile(sessionId, fileId);
      if (matches) {
        completedIdsRef.current.add(fileId);
      }

      sendControl({
        v: PROTOCOL_VERSION,
        type: 'file_ack',
        fileId,
        status: matches ? 'verified' : 'hash_mismatch',
        receivedBytes: writer.receivedBytes,
        message: matches ? undefined : 'SHA-256 verification failed',
      });

      setState((prev) => {
        const nextProgress: Record<string, FileProgressState> = {
          ...prev.fileProgress,
          [fileId]: {
            fileId,
            bytesTransferred: writer.receivedBytes,
            totalBytes: writer.meta.size,
            status: matches ? 'verified' : 'hash_mismatch',
            sha256: actualSha256,
            error: matches ? undefined : 'Integrity check mismatch. Retry this file.',
          },
        };

        const allDone = Object.values(nextProgress).length > 0 &&
          Object.values(nextProgress).every(
            (p) => p.status === 'verified' || p.status === 'cancelled'
          );

        if (allDone) {
          sendControl({ v: PROTOCOL_VERSION, type: 'transfer_complete' });
        }

        return {
          ...prev,
          lifecycle: allDone ? 'completed' : prev.lifecycle,
          fileProgress: nextProgress,
        };
      });
    },
    [sendControl]
  );

  const handleDataMessage = useCallback(
    async (data: string | ArrayBuffer) => {
      if (typeof data === 'string') {
        const msg = JSON.parse(data) as DataControlMessage;
        if (msg.type === 'manifest') {
          const prevIds = new Set(filesRef.current.map((f) => f.id));
          const added =
            filesRef.current.length > 0
              ? msg.files.filter((f) => !prevIds.has(f.id)).map((f) => f.id)
              : [];
          filesRef.current = msg.files;

          setState((prev) => ({
            ...prev,
            lifecycle: prev.lifecycle === 'connecting' ? 'waiting' : prev.lifecycle,
            manifestLabel: msg.label ?? prev.manifestLabel,
            files: msg.files,
            newlyAddedIds: [...new Set([...prev.newlyAddedIds, ...added])],
          }));
        } else if (msg.type === 'file_start') {
          seqToFileIdRef.current.set(msg.fileSeq, msg.fileId);
          const meta = filesRef.current.find((f) => f.id === msg.fileId);
          if (!meta) return;

          const existingWriter = writersRef.current.get(msg.fileId);
          if (
            existingWriter &&
            msg.startOffset > 0 &&
            existingWriter.receivedBytes === msg.startOffset
          ) {
            // Resuming existing in-memory or disk writer cleanly
            setState((prev) => ({
              ...prev,
              lifecycle: 'transferring',
            }));
            return;
          }

          let writable: FileSystemWritableFileStream | null = null;
          if (dirHandleRef.current) {
            writable = await openDirectoryWritable(dirHandleRef.current, meta.relativePath);
          }

          const startOffset = !writable ? msg.startOffset : 0;
          const nextBlockIdx =
            startOffset > 0 ? Math.floor(startOffset / ACK_INTERVAL_BYTES) : 0;

          writersRef.current.set(msg.fileId, {
            fileId: msg.fileId,
            meta,
            hasher: sha256.create(),
            receivedBytes: startOffset,
            resumedFromBytes: startOffset,
            pendingBlockChunks: [],
            pendingBlockBytes: 0,
            nextBlockIdx,
            chunks: [],
            writable,
          });

          setState((prev) => ({
            ...prev,
            lifecycle: 'transferring',
            fileProgress: {
              ...prev.fileProgress,
              [msg.fileId]: {
                fileId: msg.fileId,
                bytesTransferred: startOffset,
                totalBytes: meta.size,
                status: 'transferring',
              },
            },
          }));
        } else if (msg.type === 'file_eof') {
          setState((prev) => ({
            ...prev,
            fileProgress: {
              ...prev.fileProgress,
              [msg.fileId]: {
                ...(prev.fileProgress[msg.fileId] || {
                  fileId: msg.fileId,
                  bytesTransferred: msg.totalBytes,
                  totalBytes: msg.totalBytes,
                }),
                status: 'verifying',
              },
            },
          }));
          await finalizeFile(msg.fileId, msg.sha256, msg.totalBytes);
        } else if (msg.type === 'file_cancel') {
          const writer = writersRef.current.get(msg.fileId);
          if (writer?.writable) {
            await writer.writable.abort().catch(() => {});
          }
          writersRef.current.delete(msg.fileId);
          setState((prev) => ({
            ...prev,
            fileProgress: {
              ...prev.fileProgress,
              [msg.fileId]: {
                ...(prev.fileProgress[msg.fileId] || {
                  fileId: msg.fileId,
                  bytesTransferred: 0,
                  totalBytes: 0,
                }),
                status: 'cancelled',
              },
            },
          }));
        }
        return;
      }

      // Binary chunk frame
      const frame = decodeChunkFrame(data);
      if (!frame) return;
      const fileId = seqToFileIdRef.current.get(frame.fileSeq);
      if (!fileId) return;
      const writer = writersRef.current.get(fileId);
      if (!writer) return;

      writer.hasher.update(frame.payload);
      if (writer.writable) {
        await writer.writable.write(frame.payload as unknown as BufferSource);
      } else {
        const copy = new Uint8Array(frame.payload);
        writer.chunks.push(copy);
        writer.pendingBlockChunks.push(copy);
        writer.pendingBlockBytes += copy.byteLength;

        if (writer.pendingBlockBytes >= ACK_INTERVAL_BYTES) {
          const merged = new Uint8Array(writer.pendingBlockBytes);
          let pos = 0;
          for (const part of writer.pendingBlockChunks) {
            merged.set(part, pos);
            pos += part.byteLength;
          }
          const blockIdx = writer.nextBlockIdx++;
          writer.pendingBlockChunks = [];
          writer.pendingBlockBytes = 0;

          const acked = writer.receivedBytes + frame.payload.byteLength;
          await saveResumeBlock(
            sessionId,
            fileId,
            blockIdx,
            merged,
            acked,
            writer.meta.size
          );
          sendControl({
            v: PROTOCOL_VERSION,
            type: 'chunk_ack',
            fileId,
            ackedBytes: acked,
          });
        }
      }
      writer.receivedBytes += frame.payload.byteLength;
      bytesSinceSampleRef.current += frame.payload.byteLength;

      const now = performance.now();
      const uiInterval = document.hidden ? 500 : 80;
      if (now - lastProgressUiRef.current >= uiInterval || writer.receivedBytes >= writer.meta.size) {
        lastProgressUiRef.current = now;
        setState((prev) => ({
          ...prev,
          fileProgress: {
            ...prev.fileProgress,
            [fileId]: {
              fileId,
              bytesTransferred: writer.receivedBytes,
              totalBytes: writer.meta.size,
              status: 'transferring',
            },
          },
        }));
      }
    },
    [finalizeFile]
  );

  const connect = useCallback(async () => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (stopStatsTimerRef.current) {
      stopStatsTimerRef.current();
      stopStatsTimerRef.current = null;
    }
    dcRef.current?.close();
    pcRef.current?.close();
    signallingRef.current?.close();

    endedBySenderRef.current = false;
    setState((prev) => ({ ...prev, lifecycle: 'connecting', speedBps: 0, errorMessage: null }));
    try {
      const [config, sessionInfo] = await Promise.all([
        fetchClientConfig(),
        fetchPublicSession(sessionId),
      ]);

      setState((prev) => ({
        ...prev,
        sessionInfo,
        manifestLabel: sessionInfo.label,
      }));

      const pc = new RTCPeerConnection({
        iceServers: config.ice_servers,
        iceCandidatePoolSize: 4,
      });
      pcRef.current = pc;
      pendingCandidatesRef.current = [];

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signallingRef.current?.send({
            type: 'ice_candidate',
            candidate: event.candidate.toJSON(),
          });
        }
      };

      let sawIceDisconnect = false;
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
          sawIceDisconnect = true;
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          reconnectAttemptRef.current = 0;
          detectConnectionMode(pc).then((mode) => {
            setState((prev) => ({ ...prev, connectionMode: mode }));
          });

          // If ICE recovered on the same open DataChannel after a Wi-Fi/cellular switch,
          // re-request any pending files from their last received byte offset.
          if (sawIceDisconnect && dcRef.current?.readyState === 'open') {
            sawIceDisconnect = false;
            const pendingIds = requestedIdsRef.current.filter(
              (id) => !completedIdsRef.current.has(id)
            );
            if (pendingIds.length > 0) {
              const requests = pendingIds.map((fileId) => {
                const writer = writersRef.current.get(fileId);
                const startOffset = writer && !writer.writable ? writer.receivedBytes : 0;
                return { fileId, startOffset };
              });
              sendControl({
                v: PROTOCOL_VERSION,
                type: 'request_files',
                requests,
              });
            }
          }
        }
      };

      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        dcRef.current = dc;

        dc.onopen = () => {
          reconnectAttemptRef.current = 0;
          sendControl({
            v: PROTOCOL_VERSION,
            type: 'hello',
            role: 'recipient',
            capabilities: {
              directoryPicker: 'showDirectoryPicker' in window,
            },
          });

          detectConnectionMode(pc).then((mode) => {
            setState((prev) => ({ ...prev, connectionMode: mode }));
          });

          // Automatically resume any pending files from IndexedDB / memory offset
          const pendingIds = requestedIdsRef.current.filter(
            (id) => !completedIdsRef.current.has(id)
          );
          if (pendingIds.length > 0) {
            Promise.all(
              pendingIds.map(async (fileId) => {
                const writer = writersRef.current.get(fileId);
                if (writer && !writer.writable && writer.receivedBytes > 0) {
                  return { fileId, startOffset: writer.receivedBytes };
                }
                const meta = await getResumeMeta(sessionId, fileId);
                return { fileId, startOffset: meta?.ackedBytes ?? 0 };
              })
            ).then((requests) => {
              sendControl({
                v: PROTOCOL_VERSION,
                type: 'request_files',
                requests,
              });
            });
          }

          lastSampleTsRef.current = performance.now();
          bytesSinceSampleRef.current = 0;
          stopStatsTimerRef.current = createBgInterval(() => {
            const now = performance.now();
            const dt = Math.max(0.1, (now - lastSampleTsRef.current) / 1000);
            const rawBps = bytesSinceSampleRef.current / dt;
            const instantBps = Number.isFinite(rawBps) && rawBps >= 0 ? rawBps : 0;
            bytesSinceSampleRef.current = 0;
            lastSampleTsRef.current = now;
          setState((prev) => {
              const prevSafe = Number.isFinite(prev.speedBps) && prev.speedBps >= 0 ? prev.speedBps : 0;
              const smoothed = prevSafe > 0 ? prevSafe * 0.65 + instantBps * 0.35 : instantBps;
              const safeOut = Number.isFinite(smoothed) ? smoothed : 0;
              return {
                ...prev,
                speedBps: safeOut,
                speedHistory: [...prev.speedHistory.slice(-29), safeOut],
              };
            });
          }, 500);
        };

        // Serialize incoming async writes sequentially so chunks never reorder
        let chain = Promise.resolve();
        dc.onmessage = (msgEvent) => {
          chain = chain.then(() => handleDataMessage(msgEvent.data)).catch(console.error);
        };

        dc.onclose = () => {
          if (stopStatsTimerRef.current) {
            stopStatsTimerRef.current();
            stopStatsTimerRef.current = null;
          }

          const hasPending = requestedIdsRef.current.some(
            (id) => !completedIdsRef.current.has(id)
          );

          // If network switched mid-transfer and sender didn't end session, auto-reconnect & resume!
          if (!endedBySenderRef.current && hasPending && reconnectAttemptRef.current < 5) {
            reconnectAttemptRef.current += 1;
            const delay = Math.min(6000, 1200 * reconnectAttemptRef.current);
            setState((prev) => ({
              ...prev,
              speedBps: 0,
              lifecycle: 'connecting',
            }));
            reconnectTimerRef.current = window.setTimeout(() => {
              connect();
            }, delay);
            return;
          }

          abortAllWriters();
          setState((prev) => ({
            ...prev,
            speedBps: 0,
            lifecycle: prev.lifecycle === 'completed' ? 'completed' : 'ended',
          }));
        };
      };

      const signalClient = new SignallingClient(
        async (signal) => {
          if (signal.type === 'offer') {
            // Handles both initial offer AND mid-transfer ICE restart offers seamlessly
            await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signallingRef.current?.send({
              type: 'answer',
              sdp: answer.sdp,
            });
            while (pendingCandidatesRef.current.length > 0) {
              const cand = pendingCandidatesRef.current.shift()!;
              await pc.addIceCandidate(cand).catch(() => {});
            }
          } else if (signal.type === 'ice_candidate') {
            if (pc.remoteDescription) {
              await pc.addIceCandidate(signal.candidate).catch(() => {});
            } else {
              pendingCandidatesRef.current.push(signal.candidate);
            }
          } else if (signal.type === 'session_ended') {
            endedBySenderRef.current = true;
            abortAllWriters();
            setState((prev) => ({
              ...prev,
              speedBps: 0,
              lifecycle: prev.lifecycle === 'completed' ? 'completed' : 'ended',
              errorMessage:
                prev.lifecycle === 'completed'
                  ? null
                  : 'The sender ended this transfer session or went offline.',
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
          setState((prev) => {
            if (prev.lifecycle === 'completed' || prev.lifecycle === 'failed') return prev;
            return {
              ...prev,
              lifecycle: 'ended',
            };
          });
        }
      );

      signallingRef.current = signalClient;
      await signalClient.connect();
      signalClient.send({
        type: 'join_recipient',
        session_id: sessionId,
      });
    } catch (err) {
      if (!endedBySenderRef.current && reconnectAttemptRef.current < 3) {
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, 2000);
        return;
      }
      setState((prev) => ({
        ...prev,
        lifecycle: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unable to join transfer session',
      }));
    }
  }, [abortAllWriters, handleDataMessage, sendControl, sessionId]);

  useEffect(() => {
    purgeExpiredResumeData();
    connect();
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (stopStatsTimerRef.current) {
        stopStatsTimerRef.current();
      }
      dcRef.current?.close();
      pcRef.current?.close();
      signallingRef.current?.close();
    };
  }, [connect]);

  const requestFiles = useCallback(
    async (fileIds: string[], saveToFolder = false) => {
      if (saveToFolder && 'showDirectoryPicker' in window) {
        try {
          const picker = (
            window as Window & {
              showDirectoryPicker: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
            }
          ).showDirectoryPicker;
          dirHandleRef.current = await picker({ mode: 'readwrite' });
          setState((prev) => ({ ...prev, directoryMode: true }));
        } catch {
          return; // User cancelled folder picker
        }
      } else {
        dirHandleRef.current = null;
        setState((prev) => ({ ...prev, directoryMode: false }));
      }

      if (!dcRef.current || dcRef.current.readyState !== 'open') {
        await connect();
        return;
      }

      requestedIdsRef.current = fileIds;
      for (const id of fileIds) {
        completedIdsRef.current.delete(id);
      }

      setState((prev) => {
        const nextProgress = { ...prev.fileProgress };
        for (const id of fileIds) {
          const meta = filesRef.current.find((f) => f.id === id);
          nextProgress[id] = {
            fileId: id,
            bytesTransferred: 0,
            totalBytes: meta?.size ?? 0,
            status: 'queued',
          };
        }
        return {
          ...prev,
          lifecycle: 'transferring',
          fileProgress: nextProgress,
        };
      });

      const requests = await Promise.all(
        fileIds.map(async (fileId) => {
          if (saveToFolder) return { fileId, startOffset: 0 };
          const meta = await getResumeMeta(sessionId, fileId);
          return { fileId, startOffset: meta?.ackedBytes ?? 0 };
        })
      );
      sendControl({
        v: PROTOCOL_VERSION,
        type: 'request_files',
        requests,
      });
    },
    [connect, sendControl, sessionId]
  );

  const cancelFile = useCallback(
    (fileId: string) => {
      requestedIdsRef.current = requestedIdsRef.current.filter((id) => id !== fileId);
      sendControl({
        v: PROTOCOL_VERSION,
        type: 'file_cancel',
        fileId,
      });
      const writer = writersRef.current.get(fileId);
      if (writer) {
        writer.chunks = [];
        if (writer.writable) {
          writer.writable.abort().catch(() => {});
        }
        writersRef.current.delete(fileId);
      }
      clearResumeFile(sessionId, fileId);
      setState((prev) => {
        const nextProgress = {
          ...prev.fileProgress,
          [fileId]: {
            ...(prev.fileProgress[fileId] || {
              fileId,
              bytesTransferred: 0,
              totalBytes: 0,
            }),
            status: 'cancelled' as const,
          },
        };
        const anyActive = Object.values(nextProgress).some(
          (p) => p.status === 'transferring' || p.status === 'verifying' || p.status === 'queued'
        );
        return {
          ...prev,
          lifecycle: anyActive ? prev.lifecycle : 'waiting',
          speedBps: anyActive ? prev.speedBps : 0,
          fileProgress: nextProgress,
        };
      });
    },
    [sendControl]
  );

  const cancelAll = useCallback(() => {
    const toCancel = new Set<string>([
      ...requestedIdsRef.current,
      ...Array.from(writersRef.current.keys()),
    ]);
    requestedIdsRef.current = [];
    for (const fileId of toCancel) {
      sendControl({ v: PROTOCOL_VERSION, type: 'file_cancel', fileId });
      clearResumeFile(sessionId, fileId);
    }
    abortAllWriters();
    setState((prev) => ({
      ...prev,
      lifecycle: 'waiting',
      speedBps: 0,
      fileProgress: {},
    }));
  }, [abortAllWriters, sendControl]);

  return {
    state,
    requestFiles,
    cancelFile,
    cancelAll,
    reconnect: connect,
  };
}
