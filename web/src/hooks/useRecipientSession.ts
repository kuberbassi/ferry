import { useCallback, useEffect, useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
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

interface IncomingFileWriter {
  fileId: string;
  meta: TransferFile;
  hasher: ReturnType<typeof sha256.create>;
  receivedBytes: number;
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
  const bytesSinceSampleRef = useRef(0);
  const lastSampleTsRef = useRef(performance.now());
  const lastProgressUiRef = useRef(0);
  const statsTimerRef = useRef<number | null>(null);

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

      const actualSha256 = bytesToHex(writer.hasher.digest());
      const matches = actualSha256 === expectedSha256 && writer.receivedBytes === expectedTotal;

      if (writer.writable) {
        await writer.writable.close();
      } else if (matches) {
        triggerBlobDownload(writer.meta, writer.chunks);
      }

      writer.chunks = [];
      writersRef.current.delete(fileId);

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

          let writable: FileSystemWritableFileStream | null = null;
          if (dirHandleRef.current) {
            writable = await openDirectoryWritable(dirHandleRef.current, meta.relativePath);
          }

          writersRef.current.set(msg.fileId, {
            fileId: msg.fileId,
            meta,
            hasher: sha256.create(),
            receivedBytes: msg.startOffset,
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
                bytesTransferred: msg.startOffset,
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
        writer.chunks.push(new Uint8Array(frame.payload));
      }
      writer.receivedBytes += frame.payload.byteLength;
      bytesSinceSampleRef.current += frame.payload.byteLength;

      const now = performance.now();
      if (now - lastProgressUiRef.current >= 80 || writer.receivedBytes >= writer.meta.size) {
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
    setState((prev) => ({ ...prev, lifecycle: 'connecting', errorMessage: null }));
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

      const pc = new RTCPeerConnection({ iceServers: config.ice_servers });
      pcRef.current = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          signallingRef.current?.send({
            type: 'ice_candidate',
            candidate: event.candidate.toJSON(),
          });
        }
      };

      pc.ondatachannel = (event) => {
        const dc = event.channel;
        dc.binaryType = 'arraybuffer';
        dcRef.current = dc;

        dc.onopen = () => {
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

          lastSampleTsRef.current = performance.now();
          bytesSinceSampleRef.current = 0;
          statsTimerRef.current = window.setInterval(() => {
            const now = performance.now();
            const dt = Math.max(0.1, (now - lastSampleTsRef.current) / 1000);
            const bps = bytesSinceSampleRef.current / dt;
            bytesSinceSampleRef.current = 0;
            lastSampleTsRef.current = now;
            setState((prev) => ({
              ...prev,
              speedBps: bps,
              speedHistory: [...prev.speedHistory.slice(-29), bps],
            }));
          }, 500);
        };

        // Serialize incoming async writes sequentially so chunks never reorder
        let chain = Promise.resolve();
        dc.onmessage = (msgEvent) => {
          chain = chain.then(() => handleDataMessage(msgEvent.data)).catch(console.error);
        };

        dc.onclose = () => {
          if (statsTimerRef.current !== null) {
            window.clearInterval(statsTimerRef.current);
            statsTimerRef.current = null;
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
            await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signallingRef.current?.send({
              type: 'answer',
              sdp: answer.sdp,
            });
          } else if (signal.type === 'ice_candidate') {
            await pc.addIceCandidate(signal.candidate).catch(() => {});
          } else if (signal.type === 'session_ended') {
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
      setState((prev) => ({
        ...prev,
        lifecycle: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Unable to join transfer session',
      }));
    }
  }, [handleDataMessage, sendControl, sessionId]);

  useEffect(() => {
    connect();
    return () => {
      if (statsTimerRef.current !== null) {
        window.clearInterval(statsTimerRef.current);
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

      const requests = fileIds.map((fileId) => ({
        fileId,
        startOffset: 0,
      }));
      sendControl({
        v: PROTOCOL_VERSION,
        type: 'request_files',
        requests,
      });
    },
    [sendControl]
  );

  const cancelFile = useCallback(
    (fileId: string) => {
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
    for (const fileId of Array.from(writersRef.current.keys())) {
      sendControl({ v: PROTOCOL_VERSION, type: 'file_cancel', fileId });
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
