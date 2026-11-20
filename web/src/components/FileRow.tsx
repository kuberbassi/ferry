import React from 'react';
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
  Folder,
} from 'lucide-react';
import { FileProgressState, formatBytes, TransferFile } from '../lib/protocol';

function pickFileVisual(file: TransferFile) {
  const mime = file.mimeType.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  if (mime.startsWith('video/') || ['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext)) {
    return { Icon: FileVideo, color: 'text-[#FF3B30] bg-[#FF3B30]/10 dark:text-[#FF453A]' };
  }
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'heic'].includes(ext)) {
    return { Icon: FileImage, color: 'text-[#AF52DE] bg-[#AF52DE]/10 dark:text-[#BF5AF2]' };
  }
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'].includes(ext)) {
    return { Icon: FileAudio, color: 'text-[#FF9500] bg-[#FF9500]/10 dark:text-[#FF9F0A]' };
  }
  if (['zip', 'tar', 'gz', '7z', 'rar', 'iso', 'dmg', 'img', 'pkg'].includes(ext)) {
    return { Icon: FileArchive, color: 'text-[#FF9500] bg-[#FF9500]/10 dark:text-[#FF9F0A]' };
  }
  if (
    ['ts', 'tsx', 'js', 'jsx', 'rs', 'py', 'go', 'swift', 'json', 'yaml', 'toml', 'html', 'css'].includes(
      ext
    )
  ) {
    return { Icon: FileCode, color: 'text-[#007AFF] bg-[#007AFF]/10 dark:text-[#0A84FF]' };
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'pages', 'key'].includes(ext)) {
    return { Icon: FileText, color: 'text-[#5AC8FA] bg-[#5AC8FA]/12 dark:text-[#64D2FF]' };
  }
  return { Icon: FileIcon, color: 'text-[#8E8E93] bg-[#8E8E93]/12' };
}

interface FileRowProps {
  file: TransferFile;
  progress?: FileProgressState;
  isNew?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onRemove?: () => void;
  onCancel?: () => void;
}

export const FileRow: React.FC<FileRowProps> = React.memo(({
  file,
  progress,
  isNew,
  selectable,
  selected,
  onToggleSelect,
  onRemove,
  onCancel,
}) => {
  const { Icon, color } = pickFileVisual(file);
  const folderPath = file.relativePath.includes('/')
    ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/'))
    : null;

  const pct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesTransferred / progress.totalBytes) * 100))
      : 0;

  return (
    <div
      className={`group animate-pop-in rounded-[14px] px-3 py-2.5 transition-colors ${
        selected
          ? 'bg-[#007AFF]/[0.06] dark:bg-[#0A84FF]/[0.12]'
          : 'hover:bg-[#F2F2F7]/80 dark:hover:bg-[#2C2C2E]/60'
      }`}
    >
      <div className="flex items-center gap-3">
        {selectable && (
          <input
            type="checkbox"
            checked={Boolean(selected)}
            onChange={onToggleSelect}
            aria-label={`Select ${file.name}`}
            className="h-4 w-4 cursor-pointer rounded-md border-black/20 accent-[#007AFF] dark:border-white/20 dark:accent-[#0A84FF]"
          />
        )}

        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${color}`}>
          <Icon className="h-[18px] w-[18px]" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium tracking-[-0.01em] text-[#1D1D1F] dark:text-[#F5F5F7]">
              {file.name}
            </span>
            {isNew && (
              <span className="rounded-full bg-[#007AFF]/12 px-2 py-0.5 text-[10px] font-semibold text-[#007AFF] dark:bg-[#0A84FF]/20 dark:text-[#0A84FF]">
                New
              </span>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-[#86868B] dark:text-[#98989D]">
            <span className="tabular-nums">{formatBytes(file.size)}</span>
            {folderPath && (
              <span className="inline-flex max-w-[240px] items-center gap-1 truncate rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-[#6E6E73] dark:bg-white/[0.07] dark:text-[#AEAEB2]">
                <Folder className="h-3 w-3 shrink-0" />
                <span className="truncate">{folderPath}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {progress?.status === 'verified' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#34C759]/12 px-2.5 py-1 text-[11px] font-semibold text-[#248A3D] dark:bg-[#30D158]/15 dark:text-[#30D158]">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Verified
            </span>
          )}
          {progress?.status === 'verifying' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#5856D6]/12 px-2.5 py-1 text-[11px] font-semibold text-[#5856D6] dark:text-[#5E5CE6]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Verifying
            </span>
          )}
          {progress?.status === 'transferring' && (
            <span className="tabular-nums text-[12px] font-semibold text-[#007AFF] dark:text-[#0A84FF]">
              {pct}%
            </span>
          )}
          {(progress?.status === 'hash_mismatch' || progress?.status === 'failed') && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#FF3B30]/12 px-2.5 py-1 text-[11px] font-semibold text-[#FF3B30] dark:text-[#FF453A]">
              <AlertTriangle className="h-3.5 w-3.5" />
              Failed
            </span>
          )}

          {onCancel && progress?.status === 'transferring' && (
            <button
              type="button"
              onClick={onCancel}
              title="Cancel this file"
              className="cursor-pointer rounded-full p-1 text-[#8E8E93] transition-colors hover:bg-[#FF3B30]/10 hover:text-[#FF3B30]"
            >
              <X className="h-4 w-4" />
            </button>
          )}

          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              title="Remove file"
              className="cursor-pointer rounded-full p-1 text-[#8E8E93] transition-colors hover:bg-black/[0.06] hover:text-[#FF3B30] dark:hover:bg-white/[0.1]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {progress && (progress.status === 'transferring' || progress.status === 'verifying') && (
        <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-[#E5E5EA] dark:bg-[#3A3A3C]">
          <div
            className="h-full rounded-full bg-[#007AFF] transition-all duration-150 dark:bg-[#0A84FF]"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
});
