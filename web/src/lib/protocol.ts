export const PROTOCOL_VERSION = 1;
export const CHUNK_SIZE = 64 * 1024; // 64 KB SCTP-safe wire frame
export const DISK_READ_SIZE = 1024 * 1024; // 1 MB disk read-ahead batch
export const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2 MB safe ceiling across desktop & mobile WebRTC
export const BUFFERED_LOW_THRESHOLD = 512 * 1024; // 512 KB resume threshold
export const MAX_CONCURRENT_FILES = 3; // Parallel file transfers
export const FRAME_MAGIC = 0x46525931; // "FRY1"
export const FRAME_HEADER_BYTES = 20;

export type ExpiryPolicy = 'manual' | 'duration' | 'after_download' | 'inactivity';

export type SessionLifecycle =
  | 'draft'
  | 'creating'
  | 'waiting'
  | 'connecting'
  | 'transferring'
  | 'completed'
  | 'ended'
  | 'failed';

export type ConnectionMode = 'unknown' | 'direct' | 'relayed';

export interface TransferFile {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
  lastModified?: number;
}

export type FileTransferStatus =
  | 'queued'
  | 'transferring'
  | 'verifying'
  | 'verified'
  | 'hash_mismatch'
  | 'failed'
  | 'cancelled';

export interface FileProgressState {
  fileId: string;
  bytesTransferred: number;
  totalBytes: number;
  status: FileTransferStatus;
  sha256?: string;
  error?: string;
}

export type DataControlMessage =
  | {
      v: number;
      type: 'hello';
      role: 'sender' | 'recipient';
      capabilities: {
        directoryPicker: boolean;
      };
    }
  | {
      v: number;
      type: 'manifest';
      version: number;
      label?: string;
      files: TransferFile[];
    }
  | {
      v: number;
      type: 'request_files';
      requests: { fileId: string; startOffset: number }[];
    }
  | {
      v: number;
      type: 'file_start';
      fileId: string;
      fileSeq: number;
      startOffset: number;
      size: number;
    }
  | {
      v: number;
      type: 'file_eof';
      fileId: string;
      fileSeq: number;
      sha256: string;
      totalBytes: number;
    }
  | {
      v: number;
      type: 'file_ack';
      fileId: string;
      status: 'verified' | 'hash_mismatch' | 'error';
      receivedBytes: number;
      message?: string;
    }
  | {
      v: number;
      type: 'file_cancel';
      fileId: string;
    }
  | {
      v: number;
      type: 'transfer_complete';
    };

/**
 * Encodes a binary chunk frame:
 * [0..4]   magic (0x46525931 = "FRY1")
 * [4..8]   fileSeq (uint32 BE)
 * [8..16]  offset (uint64 BE)
 * [16..20] length (uint32 BE)
 * [20..]   payload bytes
 */
export function encodeChunkFrame(
  fileSeq: number,
  offset: number,
  payload: Uint8Array
): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, FRAME_MAGIC, false);
  view.setUint32(4, fileSeq >>> 0, false);
  view.setBigUint64(8, BigInt(offset), false);
  view.setUint32(16, payload.byteLength >>> 0, false);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(payload);
  return buffer;
}

export interface DecodedChunkFrame {
  fileSeq: number;
  offset: number;
  payload: Uint8Array;
}

export function decodeChunkFrame(buffer: ArrayBuffer): DecodedChunkFrame | null {
  if (buffer.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, false) !== FRAME_MAGIC) return null;
  const fileSeq = view.getUint32(4, false);
  const offset = Number(view.getBigUint64(8, false));
  const length = view.getUint32(16, false);
  if (FRAME_HEADER_BYTES + length > buffer.byteLength) return null;
  const payload = new Uint8Array(buffer, FRAME_HEADER_BYTES, length);
  return { fileSeq, offset, payload };
}

/**
 * Normalizes and sanitizes relative paths to prevent path traversal or unsafe names.
 */
export function sanitizeRelativePath(rawPath: string, fallbackName: string): string {
  const normalized = rawPath.replace(/\\/g, '/').trim();
  const segments = normalized
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
  if (segments.length === 0) {
    return sanitizeFileName(fallbackName);
  }
  return segments.map(sanitizeFileName).join('/');
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'unnamed_file';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.max(
    0,
    Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  );
  const value = bytes / Math.pow(1024, exp);
  return `${value >= 100 || exp === 0 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)} ${units[exp]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatEta(remainingBytes: number, bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1024 || remainingBytes <= 0) {
    return '—';
  }
  const secs = Math.ceil(remainingBytes / bytesPerSec);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}
