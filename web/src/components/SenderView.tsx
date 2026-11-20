import React, { useEffect, useMemo, useRef, useState } from 'react';
import gsap from 'gsap';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowUpCircle,
  FolderUp,
  FilePlus2,
  Copy,
  Check,
  Share2,
  Power,
  AlertCircle,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import {
  collectFromDataTransfer,
  collectFromFileList,
  LocalTransferItem,
  mergeLocalItems,
} from '../lib/fileCollector';
import { ExpiryPolicy, formatBytes } from '../lib/protocol';
import { useSenderSession } from '../hooks/useSenderSession';
import { FileRow } from './FileRow';
import { PeerLinkVisualizer } from './FerryLogo';
import { SpeedSparkline } from './SpeedSparkline';

const EXPIRY_OPTIONS: { policy: ExpiryPolicy; ttl: number; label: string; hint: string }[] = [
  { policy: 'duration', ttl: 900, label: '15 min', hint: 'Expires in 15 min' },
  { policy: 'duration', ttl: 3600, label: '1 hour', hint: 'Expires in 1 hour' },
  { policy: 'after_download', ttl: 3600, label: 'Auto-close', hint: 'Ends after download' },
  { policy: 'manual', ttl: 86400, label: 'Manual', hint: 'Active until closed' },
];

export const SenderView: React.FC = () => {
  const [items, setItems] = useState<LocalTransferItem[]>([]);
  const [label, setLabel] = useState('');
  const [selectedExpiryIdx, setSelectedExpiryIdx] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const sheenRef = useRef<HTMLDivElement>(null);
  const rafSpotRef = useRef<number | null>(null);
  const coreIconRef = useRef<HTMLDivElement>(null);
  const activeGridRef = useRef<HTMLDivElement>(null);

  const activeExpiry = EXPIRY_OPTIONS[selectedExpiryIdx];
  const { state, startSession, endSession, cancelFile } = useSenderSession(
    items,
    label,
    activeExpiry.policy,
    activeExpiry.ttl
  );

  const totalSize = useMemo(
    () => items.reduce((sum, item) => sum + item.meta.size, 0),
    [items]
  );

  const transferredBytes = useMemo(
    () =>
      Object.values(state.fileProgress).reduce((sum, p) => sum + p.bytesTransferred, 0),
    [state.fileProgress]
  );

  const requestedTotalBytes = useMemo(() => {
    const tracked = Object.values(state.fileProgress);
    if (tracked.length === 0) return totalSize;
    return tracked.reduce((sum, p) => sum + p.totalBytes, 0);
  }, [state.fileProgress, totalSize]);

  const isSessionActive =
    state.lifecycle === 'waiting' ||
    state.lifecycle === 'connecting' ||
    state.lifecycle === 'transferring' ||
    state.lifecycle === 'completed';

  // GSAP Hero & Dropzone staggered entrance
  useEffect(() => {
    if (isSessionActive) return;
    const ctx = gsap.context(() => {
      if (heroRef.current) {
        gsap.fromTo(
          heroRef.current.children,
          { y: 20, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.75, stagger: 0.1, ease: 'power3.out' }
        );
      }
      if (dropzoneRef.current) {
        gsap.fromTo(
          dropzoneRef.current,
          { y: 24, opacity: 0, scale: 0.985 },
          { y: 0, opacity: 1, scale: 1, duration: 0.85, delay: 0.15, ease: 'power3.out' }
        );
      }
    });
    return () => ctx.revert();
  }, [isSessionActive]);

  // GSAP Active Session Dashboard entrance
  useEffect(() => {
    if (!isSessionActive || !activeGridRef.current) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        activeGridRef.current!.children,
        { y: 18, opacity: 0, scale: 0.97 },
        { y: 0, opacity: 1, scale: 1, duration: 0.65, stagger: 0.1, ease: 'back.out(1.2)' }
      );
    });
    return () => ctx.revert();
  }, [isSessionActive]);

  // GSAP Drag-over magnetic bounce on center icon
  useEffect(() => {
    if (!coreIconRef.current) return;
    gsap.to(coreIconRef.current, {
      scale: isDragging ? 1.14 : 1,
      y: isDragging ? -4 : 0,
      duration: 0.35,
      ease: 'back.out(1.8)',
    });
  }, [isDragging]);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const collected = await collectFromDataTransfer(e.dataTransfer);
    if (collected.length > 0) {
      setItems((prev) => mergeLocalItems(prev, collected));
    }
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const collected = collectFromFileList(e.target.files);
      setItems((prev) => mergeLocalItems(prev, collected));
      e.target.value = '';
    }
  };

  const handleCopy = async () => {
    if (!state.shareUrl) return;
    await navigator.clipboard.writeText(state.shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const handleNativeShare = async () => {
    if (!state.shareUrl || !navigator.share) return;
    await navigator
      .share({
        title: label ? `Ferry: ${label}` : 'Ferry Transfer',
        text: `Download ${items.length} file(s) (${formatBytes(totalSize)})`,
        url: state.shareUrl,
      })
      .catch(() => {});
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = dropzoneRef.current;
    const sheen = sheenRef.current;
    if (!el || !sheen) return;
    const clientX = e.clientX;
    const clientY = e.clientY;
    if (rafSpotRef.current !== null) return;
    rafSpotRef.current = window.requestAnimationFrame(() => {
      rafSpotRef.current = null;
      const rect = el.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * 100;
      const y = ((clientY - rect.top) / rect.height) * 100;
      sheen.style.setProperty('--spot-x', `${x.toFixed(1)}%`);
      sheen.style.setProperty('--spot-y', `${y.toFixed(1)}%`);
      sheen.style.opacity = '1';
    });
  };

  const handleMouseLeave = () => {
    if (sheenRef.current && !isDragging) {
      sheenRef.current.style.opacity = '0';
    }
  };

  return (
    <div className="space-y-10">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilePick}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is a non-standard but widely supported attribute
        webkitdirectory=""
        className="hidden"
        onChange={handleFilePick}
      />

      {!isSessionActive ? (
        <>
          {/* Clean Editorial Hero (Apple DESIGN.md scale) */}
          <div ref={heroRef} className="mx-auto max-w-2xl pt-2 text-center sm:pt-6">
            <h1 className="apple-hero-title text-[34px] font-semibold text-[#1d1d1f] sm:text-[56px] dark:text-white">
              Big files. One scan.
              <br />
              <span className="bg-gradient-to-r from-[#0066cc] via-[#2997ff] to-[#38BDF8] bg-clip-text text-transparent">
                Zero storage.
              </span>
            </h1>
            <p className="apple-body mx-auto mt-3 max-w-md text-[15px] font-normal text-[#7a7a7a] sm:mt-4 sm:text-[17px] dark:text-[#cccccc]/80">
              Send files or folders straight to another device. Keep this tab open until they finish.
            </p>
          </div>

          {/* Focused Liquid Glass Dropzone with GSAP + Specular Aurora Sheen */}
          <div
            ref={dropzoneRef}
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            className={`liquid-glass group relative overflow-hidden rounded-[28px] px-5 py-11 text-center transition-shadow duration-300 sm:rounded-[32px] sm:px-12 sm:py-20 ${
              isDragging ? 'ring-2 ring-[#2997ff]/75' : ''
            }`}
          >
            {/* Zero-rerender Pointer-Tracking Aurora Sheen */}
            <div
              ref={sheenRef}
              className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300"
              style={{
                opacity: isDragging ? 1 : undefined,
                background:
                  'radial-gradient(600px circle at var(--spot-x, 50%) var(--spot-y, 50%), rgba(41, 151, 255, 0.16), rgba(129, 140, 248, 0.05) 40%, transparent 65%)',
              }}
            />

            <div className="relative z-10 mx-auto flex max-w-md flex-col items-center">
              <div className="relative mb-6 flex h-20 w-20 items-center justify-center">
                <span className="animate-airdrop-ripple absolute inset-0 rounded-full border border-[#0071e3]/35 dark:border-[#2997ff]/40" />
                <div
                  ref={coreIconRef}
                  className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-b from-[#38BDF8]/25 to-[#0071e3]/20 text-[#0066cc] shadow-[inset_0_1px_1px_rgba(255,255,255,0.55)] backdrop-blur-xl dark:text-[#2997ff]"
                >
                  <ArrowUpCircle className="h-9 w-9 stroke-[1.65]" />
                </div>
              </div>

              <h2 className="text-[22px] font-semibold tracking-[-0.02em] text-[#1d1d1f] dark:text-white">
                {isDragging ? 'Drop to add' : 'Drop files or folders'}
              </h2>

              <div className="mt-6 flex w-full flex-col items-center justify-center gap-2.5 sm:mt-7 sm:w-auto sm:flex-row sm:gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="liquid-btn-primary inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full px-6 py-2.5 text-[14px] font-medium text-white sm:w-auto"
                >
                  <FilePlus2 className="h-4 w-4" />
                  Choose Files
                </button>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="liquid-glass-pill inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-full px-6 py-2.5 text-[14px] font-medium text-[#1d1d1f] transition-transform hover:scale-[1.03] active:scale-[0.97] sm:w-auto dark:text-white"
                >
                  <FolderUp className="h-4 w-4 text-[#0066cc] dark:text-[#2997ff]" />
                  Choose Folder
                </button>
              </div>
            </div>
          </div>

          {/* Selected Files Sheet */}
          {items.length > 0 && (
            <div className="liquid-glass animate-pop-in rounded-[30px] p-6 sm:p-7">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] pb-4 dark:border-white/[0.1]">
                <div>
                  <h3 className="text-[17px] font-semibold tracking-[-0.015em] text-[#1d1d1f] dark:text-white">
                    {items.length} {items.length === 1 ? 'Item' : 'Items'}
                  </h3>
                  <p className="tabular-nums text-[13px] text-[#7a7a7a] dark:text-[#cccccc]/70">
                    {formatBytes(totalSize)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="liquid-glass-pill inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium text-[#1d1d1f] transition-transform active:scale-[0.96] dark:text-white"
                  >
                    <FilePlus2 className="h-3.5 w-3.5" />
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setItems([])}
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-medium text-[#FF3B30] transition-colors hover:bg-[#FF3B30]/12 dark:text-[#FF453A]"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="mt-3 max-h-72 divide-y divide-black/[0.05] overflow-y-auto pr-1 dark:divide-white/[0.07]">
                {items.map((item) => (
                  <FileRow
                    key={item.meta.id}
                    file={item.meta}
                    onRemove={() =>
                      setItems((prev) => prev.filter((i) => i.meta.id !== item.meta.id))
                    }
                  />
                ))}
              </div>

              <div className="mt-5 grid gap-5 border-t border-black/[0.06] pt-5 sm:grid-cols-2 dark:border-white/[0.1]">
                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-[#7a7a7a] dark:text-[#cccccc]/75">
                    Label (optional)
                  </label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. Studio Export"
                    maxLength={80}
                    className="w-full rounded-[14px] border border-black/[0.08] bg-white/60 px-3.5 py-2 text-[14px] text-[#1d1d1f] placeholder:text-[#8E8E93] focus:border-[#0071e3] focus:bg-white focus:outline-none dark:border-white/[0.12] dark:bg-white/[0.07] dark:text-white dark:focus:border-[#2997ff] dark:focus:bg-white/[0.1]"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-[12px] font-medium text-[#7a7a7a] dark:text-[#cccccc]/75">
                    Expires
                  </label>
                  <div className="grid grid-cols-2 gap-1 rounded-[14px] bg-black/[0.06] p-1 sm:grid-cols-4 dark:bg-white/[0.08]">
                    {EXPIRY_OPTIONS.map((opt, idx) => (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => setSelectedExpiryIdx(idx)}
                        title={opt.hint}
                        className={`cursor-pointer rounded-[10px] px-2 py-1.5 text-[12px] font-medium transition-all ${
                          selectedExpiryIdx === idx
                            ? 'bg-white text-[#1d1d1f] shadow-sm dark:bg-white/20 dark:text-white'
                            : 'text-[#7a7a7a] hover:text-[#1d1d1f] dark:text-[#cccccc]/70 dark:hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {state.lifecycle === 'failed' && state.errorMessage && (
                <div className="mt-4 flex items-center gap-2 rounded-[14px] bg-[#FF3B30]/12 px-4 py-3 text-[13px] font-medium text-[#FF3B30] dark:text-[#FF453A]">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {state.errorMessage}
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
                <span className="text-[12px] text-[#7a7a7a] dark:text-[#cccccc]/70">
                  Keep this tab open while sharing.
                </span>

                <button
                  type="button"
                  disabled={state.lifecycle === 'creating'}
                  onClick={startSession}
                  className="liquid-btn-primary inline-flex cursor-pointer items-center gap-2 rounded-full px-6 py-2.5 text-[14px] font-medium text-white disabled:opacity-60"
                >
                  {state.lifecycle === 'creating' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    <>Create Transfer</>
                  )}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        /* Active Session Dashboard */
        <div ref={activeGridRef} className="grid items-start gap-6 lg:grid-cols-5">
          <div className="liquid-glass flex flex-col items-center justify-between rounded-[30px] p-6 text-center lg:col-span-2">
            <div className="w-full">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-[#34C759]/15 px-3 py-1 text-[11px] font-semibold text-[#248A3D] dark:bg-[#30D158]/20 dark:text-[#30D158]">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#34C759]" />
                Online · {activeExpiry.hint}
              </div>
              <h2 className="mt-3 text-[19px] font-semibold tracking-[-0.02em] text-[#1d1d1f] dark:text-white">
                {label || 'Ready to Scan'}
              </h2>
              <p className="mt-0.5 text-[13px] text-[#7a7a7a] dark:text-[#cccccc]/70">
                Scan or copy the link
              </p>
            </div>

            <div className="relative my-5 overflow-hidden rounded-[22px] border border-black/[0.07] bg-white p-4 shadow-[0_2px_10px_rgba(0,0,0,0.04)] dark:border-white/[0.15]">
              <div className="animate-scan-sweep pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-[#2997ff]/20 to-transparent" />
              {state.shareUrl && (
                <QRCodeSVG
                  value={state.shareUrl}
                  size={192}
                  level="M"
                  bgColor="#ffffff"
                  fgColor="#1d1d1f"
                />
              )}
            </div>

            <div className="w-full space-y-2.5">
              <div className="flex items-center gap-2 rounded-[14px] border border-black/[0.08] bg-black/[0.035] p-1.5 pl-3 dark:border-white/[0.1] dark:bg-white/[0.06]">
                <span className="flex-1 truncate font-mono text-[12px] text-[#555555] dark:text-[#cccccc]">
                  {state.shareUrl}
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="liquid-btn-primary inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[12px] font-medium text-white"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              <div className="flex gap-2">
                {'share' in navigator && (
                  <button
                    type="button"
                    onClick={handleNativeShare}
                    className="liquid-glass-pill inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 py-2 text-[13px] font-medium text-[#1d1d1f] transition-transform active:scale-[0.97] dark:text-white"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    Share
                  </button>
                )}
                <button
                  type="button"
                  onClick={endSession}
                  className="inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-[#FF3B30]/20 bg-[#FF3B30]/10 px-3 py-2 text-[13px] font-medium text-[#FF3B30] transition-all hover:bg-[#FF3B30]/18 active:scale-[0.97] dark:border-[#FF453A]/25 dark:text-[#FF453A]"
                >
                  <Power className="h-3.5 w-3.5" />
                  End
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-5 lg:col-span-3">
            <PeerLinkVisualizer
              connected={state.recipientConnected}
              transferring={state.lifecycle === 'transferring'}
              connectionMode={state.connectionMode}
              role="sender"
            />

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
                  <div className="text-[14px] font-semibold">Transfer Complete</div>
                  <div className="text-[12px] opacity-90">
                    All files received and verified.
                  </div>
                </div>
              </div>
            )}

            <div className="liquid-glass rounded-[28px] p-5">
              <div className="flex items-center justify-between gap-2 pb-3">
                <div>
                  <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[#1d1d1f] dark:text-white">
                    Files ({items.length})
                  </h3>
                  <p className="tabular-nums text-[12px] text-[#7a7a7a] dark:text-[#cccccc]/70">
                    {formatBytes(totalSize)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#0071e3]/20 bg-[#0071e3]/10 px-3.5 py-1.5 text-[12px] font-semibold text-[#0066cc] transition-colors hover:bg-[#0071e3]/18 dark:border-[#2997ff]/25 dark:bg-[#2997ff]/20 dark:text-[#2997ff]"
                >
                  <FilePlus2 className="h-3.5 w-3.5" />
                  Add
                </button>
              </div>

              <div className="max-h-80 divide-y divide-black/[0.05] overflow-y-auto pr-1 dark:divide-white/[0.07]">
                {items.map((item) => (
                  <FileRow
                    key={item.meta.id}
                    file={item.meta}
                    progress={state.fileProgress[item.meta.id]}
                    onCancel={() => cancelFile(item.meta.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
