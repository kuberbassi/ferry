import { sanitizeRelativePath, TransferFile } from './protocol';

export interface LocalTransferItem {
  meta: TransferFile;
  file: File;
}

function makeFileId(file: File, relativePath: string): string {
  return `${relativePath}::${file.size}::${file.lastModified}`;
}

function toLocalItem(file: File, rawRelPath?: string): LocalTransferItem {
  const rel = sanitizeRelativePath(
    rawRelPath || (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    file.name
  );
  const name = rel.split('/').pop() || file.name;
  return {
    file,
    meta: {
      id: makeFileId(file, rel),
      name,
      relativePath: rel,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
    },
  };
}

export function collectFromFileList(list: FileList | File[]): LocalTransferItem[] {
  const items: LocalTransferItem[] = [];
  for (const file of Array.from(list)) {
    items.push(toLocalItem(file));
  }
  return items;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: FileSystemEntryLike[]) => void, error?: (err: unknown) => void) => void;
  };
}

async function readEntryRecursively(
  entry: FileSystemEntryLike,
  prefix = ''
): Promise<LocalTransferItem[]> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!(resolve, reject);
    });
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return [toLocalItem(file, relPath)];
  }

  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const allEntries: FileSystemEntryLike[] = [];

    // readEntries returns batches (typically up to 100 at a time) until empty
    while (true) {
      const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (batch.length === 0) break;
      allEntries.push(...batch);
    }

    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    const nested = await Promise.all(
      allEntries.map((child) => readEntryRecursively(child, nextPrefix))
    );
    return nested.flat();
  }

  return [];
}

export async function collectFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<LocalTransferItem[]> {
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map(
      (item) =>
        (item as DataTransferItem & { webkitGetAsEntry?: () => unknown }).webkitGetAsEntry?.() as
          | FileSystemEntryLike
          | null
          | undefined
    )
    .filter((entry): entry is FileSystemEntryLike => Boolean(entry));

  if (entries.length > 0) {
    const collected = await Promise.all(entries.map((entry) => readEntryRecursively(entry)));
    return collected.flat();
  }

  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return collectFromFileList(dataTransfer.files);
  }

  return [];
}

export function mergeLocalItems(
  existing: LocalTransferItem[],
  incoming: LocalTransferItem[]
): LocalTransferItem[] {
  const seen = new Set(existing.map((i) => i.meta.id));
  const merged = [...existing];
  for (const item of incoming) {
    if (!seen.has(item.meta.id)) {
      seen.add(item.meta.id);
      merged.push(item);
    }
  }
  return merged;
}
