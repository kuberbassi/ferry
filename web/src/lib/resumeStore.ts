/**
 * Temporary IndexedDB chunk retention for resumable transfers.
 * Stores verified 1 MB blocks during an active transfer and purges them
 * immediately upon completion, cancellation, or expiry (>24h).
 */

const DB_NAME = 'ferry-resume-db';
const DB_VERSION = 1;
const STORE_BLOCKS = 'blocks';
const STORE_META = 'meta';

export interface ResumeMeta {
  key: string; // `${sessionId}::${fileId}`
  sessionId: string;
  fileId: string;
  ackedBytes: number;
  blockCount: number;
  totalSize: number;
  updatedAt: number;
}

function makeKey(sessionId: string, fileId: string): string {
  return `${sessionId}::${fileId}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOCKS)) {
        const blocks = db.createObjectStore(STORE_BLOCKS, { keyPath: ['key', 'idx'] });
        blocks.createIndex('by_key', 'key', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveResumeBlock(
  sessionId: string,
  fileId: string,
  blockIdx: number,
  data: Uint8Array,
  ackedBytes: number,
  totalSize: number
): Promise<void> {
  try {
    const db = await openDb();
    const key = makeKey(sessionId, fileId);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_BLOCKS, STORE_META], 'readwrite');
      tx.objectStore(STORE_BLOCKS).put({ key, idx: blockIdx, data });
      const meta: ResumeMeta = {
        key,
        sessionId,
        fileId,
        ackedBytes,
        blockCount: blockIdx + 1,
        totalSize,
        updatedAt: Date.now(),
      };
      tx.objectStore(STORE_META).put(meta);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore IndexedDB quota/private-mode errors gracefully
  }
}

export async function getResumeMeta(
  sessionId: string,
  fileId: string
): Promise<ResumeMeta | null> {
  try {
    const db = await openDb();
    const key = makeKey(sessionId, fileId);
    const result = await new Promise<ResumeMeta | null>((resolve) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).get(key);
      req.onsuccess = () => resolve((req.result as ResumeMeta) || null);
      req.onerror = () => resolve(null);
    });
    db.close();
    return result;
  } catch {
    return null;
  }
}

export async function readResumeBlocks(
  sessionId: string,
  fileId: string
): Promise<Uint8Array[]> {
  try {
    const db = await openDb();
    const key = makeKey(sessionId, fileId);
    const records = await new Promise<{ idx: number; data: Uint8Array }[]>((resolve) => {
      const tx = db.transaction(STORE_BLOCKS, 'readonly');
      const index = tx.objectStore(STORE_BLOCKS).index('by_key');
      const req = index.getAll(key);
      req.onsuccess = () =>
        resolve((req.result as { idx: number; data: Uint8Array }[]) || []);
      req.onerror = () => resolve([]);
    });
    db.close();
    records.sort((a, b) => a.idx - b.idx);
    return records.map((r) => r.data);
  } catch {
    return [];
  }
}

export async function clearResumeFile(sessionId: string, fileId: string): Promise<void> {
  try {
    const db = await openDb();
    const key = makeKey(sessionId, fileId);
    await new Promise<void>((resolve) => {
      const tx = db.transaction([STORE_BLOCKS, STORE_META], 'readwrite');
      tx.objectStore(STORE_META).delete(key);
      const index = tx.objectStore(STORE_BLOCKS).index('by_key');
      const cursorReq = index.openCursor(key);
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    // Ignore
  }
}

export async function purgeExpiredResumeData(): Promise<void> {
  try {
    const db = await openDb();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const metas = await new Promise<ResumeMeta[]>((resolve) => {
      const tx = db.transaction(STORE_META, 'readonly');
      const req = tx.objectStore(STORE_META).getAll();
      req.onsuccess = () => resolve((req.result as ResumeMeta[]) || []);
      req.onerror = () => resolve([]);
    });
    db.close();

    for (const m of metas) {
      if (m.updatedAt < cutoff) {
        await clearResumeFile(m.sessionId, m.fileId);
      }
    }
  } catch {
    // Ignore
  }
}
