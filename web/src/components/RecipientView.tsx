import React, { useEffect, useMemo, useState } from 'react';
import {
  Download,
  FolderDown,
  Loader2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ShieldCheck,
} from 'lucide-react';
import { formatBytes } from '../lib/protocol';
import { useRecipientSession } from '../hooks/useRecipientSession';
import { FileRow } from './FileRow';
import { PeerLinkVisualizer } from './FerryLogo';
import { SpeedSparkline } from './SpeedSparkline';

interface RecipientViewProps {
  sessionId: string;
  onExitToSender: () => void;
}

export const RecipientView: React.FC<RecipientViewProps> = ({
  sessionId,
  onExitToSender,
}) => {
  const { state, requestFiles, cancelFile, cancelAll, reconnect } =
    useRecipientSession(sessionId);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const supportsDirectoryPicker = 'showDirectoryPicker' in window;
  const hasFolders = useMemo(
    () => state.files.some((f) => f.relativePath.includes('/')),
    [state.files]
  );

  useEffect(() => {
    if (state.files.length > 0 && selectedIds.size === 0) {
      setSelectedIds(new Set(state.files.map((f) => f.id)));
    }
  }, [state.files, selectedIds.size]);

  const totalSize = useMemo(
    () => state.files.reduce((sum, f) => sum + f.size, 0),
    [state.files]
  );

  const selectedSize = useMemo(
    () =>
      state.files
        .filter((f) => selectedIds.has(f.id))
        .reduce((sum, f) => sum + f.size, 0),
    [state.files, selectedIds]
  );

  const transferredBytes = useMemo(
    () =>
      Object.values(state.fileProgress).reduce((sum, p) => sum + p.bytesTransferred, 0),
    [state.fileProgress]
  );

  const requestedTotalBytes = useMemo(() => {
    const tracked = Object.values(state.fileProgress);
    if (tracked.length === 0) return selectedSize || totalSize;
    return tracked.reduce((sum, p) => sum + p.totalBytes, 0);
  }, [selectedSize, state.fileProgress, totalSize]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedIds.size === state.files.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(state.files.map((f) => f.id)));
    }
  };

  const isConnected =
    state.lifecycle === 'waiting' ||
    state.lifecycle === 'transferring' ||
    state.lifecycle === 'completed';

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onExitToSender}
          className="liquid-glass-pill inline-flex cursor-pointer items-center gap-1 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-[#007AFF] transition-transform active:scale-[0.97] dark:text-[#38BDF8]"
        >
          <ChevronLeft className="h-4 w-4" />
          Send Files
        </button>

        <span className="liquid-glass-pill rounded-full px-3 py-1 font-mono text-[11px] text-[#6E6E73] dark:text-[#AEAEB2]">
          {sessionId.slice(0, 8)}…
        </span>
      </div>

      <PeerLinkVisualizer
        connected={isConnected}
        transferring={state.lifecycle === 'transferring'}
        connectionMode={state.connectionMode}
        role="recipient"
      />

      {state.lifecycle === 'connecting' && (
        <div className="liquid-glass rounded-[30px] p-10 text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#007AFF] dark:text-[#38BDF8]" />
          <h2 className="mt-4 text-[18px] font-semibold tracking-[-0.02em] text-[#1D1D1F] dark:text-white">
            Connecting to Sender…
          </h2>
          <p className="mt-1 text-[13px] text-[#6E6E73] dark:text-[#98989D]">
            Establishing direct encrypted WebRTC channel
          </p>
        </div>
      )}

      {(state.lifecycle === 'failed' || state.lifecycle === 'ended') && (
        <div className="liquid-glass animate-pop-in rounded-[30px] p-8 text-center">
          <AlertTriangle className="mx-auto h-10 w-10 text-[#FF9500]" />
          <h2 className="mt-3 text-[18px] font-semibold tracking-[-0.02em] text-[#1D1D1F] dark:text-white">
            {state.lifecycle === 'ended' ? 'Transfer Session Ended' : 'Unable to Connect'}
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] text-[#6E6E73] dark:text-[#98989D]">
            {state.errorMessage ||
              'The sender closed their tab or the session expired. Request a new link from the sender.'}
          </p>
          <div className="mt-5">
            <button
              type="button"
              onClick={reconnect}
              className="liquid-btn-primary inline-flex cursor-pointer items-center gap-1.5 rounded-full px-5 py-2 text-[13px] font-semibold text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Try Again
            </button>
          </div>
        </div>
      )}

      {isConnected && (
        <div className="animate-pop-in space-y-4">
          {(state.lifecycle === 'transferring' || state.lifecycle === 'completed') && (
            <SpeedSparkline
              speedBps={state.speedBps}
              history={state.speedHistory}
              transferredBytes={transferredBytes}
              totalBytes={requestedTotalBytes}
            />
          )}

          {state.lifecycle === 'completed' && (
            <div className="liquid-glass flex items-center gap-3 rounded-[20px] px-4 py-3.5 text-[#248A3D] dark:text-[#30D158]">
              <CheckCircle2 className="h-5 w-5 shrink-0" />
              <div>
                <div className="text-[14px] font-semibold">Saved &amp; Verified</div>
                <div className="text-[12px] opacity-90">
                  Every file passed SHA-256 integrity verification.
                </div>
              </div>
            </div>
          )}

          <div className="liquid-glass rounded-[30px] p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] pb-4 dark:border-white/[0.1]">
              <div>
                <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-[#1D1D1F] dark:text-white">
                  {state.manifestLabel || 'Incoming Transfer'}
                </h2>
                <p className="tabular-nums text-[12px] text-[#6E6E73] dark:text-[#98989D]">
                  {state.files.length} {state.files.length === 1 ? 'file' : 'files'} ·{' '}
                  {formatBytes(totalSize)}
                </p>
              </div>

              {state.files.length > 1 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="liquid-glass-pill cursor-pointer rounded-full px-3.5 py-1.5 text-[12px] font-medium text-[#1D1D1F] transition-transform active:scale-[0.96] dark:text-white"
                >
                  {selectedIds.size === state.files.length ? 'Deselect All' : 'Select All'}
                </button>
              )}
            </div>

            <div className="mt-3 max-h-80 divide-y divide-black/[0.05] overflow-y-auto pr-1 dark:divide-white/[0.07]">
              {state.files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  progress={state.fileProgress[file.id]}
                  isNew={state.newlyAddedIds.includes(file.id)}
                  selectable={state.lifecycle !== 'transferring'}
                  selected={selectedIds.has(file.id)}
                  onToggleSelect={() => toggleSelect(file.id)}
                  onCancel={() => cancelFile(file.id)}
                />
              ))}
            </div>

            {hasFolders && !supportsDirectoryPicker && (
              <p className="mt-3 text-[12px] text-[#FF9500]">
                Your browser does not support direct folder writing; files will download
                individually.
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-black/[0.06] pt-4 dark:border-white/[0.1]">
              <div className="flex items-center gap-1.5 text-[12px] text-[#6E6E73] dark:text-[#98989D]">
                <ShieldCheck className="h-4 w-4 text-[#34C759]" />
                <span>SHA-256 verified on receipt</span>
              </div>

              <div className="flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row">
                {state.lifecycle === 'transferring' ? (
                  <button
                    type="button"
                    onClick={cancelAll}
                    className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full border border-[#FF3B30]/25 bg-[#FF3B30]/12 px-5 py-2.5 text-[13px] font-semibold text-[#FF3B30] transition-all hover:bg-[#FF3B30]/20 active:scale-[0.97] sm:w-auto sm:py-2 dark:text-[#FF453A]"
                  >
                    Cancel Transfer
                  </button>
                ) : (
                  <>
                    {supportsDirectoryPicker && (
                      <button
                        type="button"
                        disabled={selectedIds.size === 0}
                        onClick={() => requestFiles(Array.from(selectedIds), true)}
                        className="liquid-glass-pill inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full px-4 py-2.5 text-[13px] font-semibold text-[#1D1D1F] transition-transform active:scale-[0.97] disabled:opacity-50 sm:w-auto sm:py-2 dark:text-white"
                      >
                        <FolderDown className="h-4 w-4 text-[#007AFF] dark:text-[#38BDF8]" />
                        Save to Folder
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={selectedIds.size === 0}
                      onClick={() => requestFiles(Array.from(selectedIds), false)}
                      className="liquid-btn-primary inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50 sm:w-auto sm:py-2"
                    >
                      <Download className="h-4 w-4" />
                      {selectedIds.size === state.files.length
                        ? `Download All (${formatBytes(selectedSize)})`
                        : `Download ${selectedIds.size} (${formatBytes(selectedSize)})`}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
