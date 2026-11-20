import React from 'react';
import { ConnectionMode } from '../lib/protocol';
import { Laptop, Smartphone, Lock, Radio } from 'lucide-react';

export const FerryLogo: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div className={`group inline-flex items-center gap-2.5 select-none ${className}`}>
    {/* Apple App-Icon Squircle containing the custom Ferry mark */}
    <div className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[10px] bg-gradient-to-b from-[#38BDF8] via-[#0071e3] to-[#092B68] shadow-[inset_0_1px_1px_rgba(255,255,255,0.6),inset_0_-1px_2px_rgba(0,0,0,0.25),0_4px_14px_rgba(0,113,227,0.35)] transition-transform duration-300 group-hover:scale-[1.05]">
      {/* Subtle Apple-style top specular gloss */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[48%] bg-gradient-to-b from-white/30 to-transparent" />

      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 1200 760"
        className="relative h-6 w-7 drop-shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
        role="img"
        aria-label="Ferry icon"
      >
        <g fill="none" strokeLinecap="round" strokeLinejoin="round">
          {/* Navigation arc */}
          <path
            d="M238 345 C405 205 612 113 835 102"
            stroke="rgba(255,255,255,0.75)"
            strokeWidth="24"
          />
          <path
            d="M939 111 C1047 122 1083 174 1046 235 C1016 284 957 338 902 391"
            stroke="rgba(255,255,255,0.65)"
            strokeWidth="24"
          />
          {/* Upper deck & bridge */}
          <path
            d="M458 408 L502 354 Q526 326 567 326 H665 Q691 326 714 348 L777 408"
            stroke="#ffffff"
            strokeWidth="28"
          />
          <path
            d="M585 325 L601 265 Q606 245 629 245 H666 Q687 245 705 260 L735 282"
            stroke="#ffffff"
            strokeWidth="28"
          />
          {/* Flag */}
          <path d="M650 245 V174" stroke="#ffffff" strokeWidth="22" />
          <path
            d="M655 177 Q700 159 739 179 Q704 201 655 190 Z"
            fill="#ffffff"
            stroke="none"
          />
          {/* Main hull */}
          <path
            d="M328 500 L380 427 Q399 400 438 397 L826 397 Q855 397 876 420 L946 500 Q899 458 854 449 Q812 441 764 441 H480 Q407 441 328 500 Z"
            fill="#ffffff"
            stroke="none"
          />
          {/* Windows */}
          <g fill="#0071e3" stroke="none">
            <path d="M615 453 L655 453 L630 493 H589 Z" />
            <path d="M690 453 L730 453 L705 493 H664 Z" />
            <path d="M765 453 L805 453 L780 493 H739 Z" />
            <path d="M840 453 L880 453 L855 493 H814 Z" />
          </g>
          {/* Wave one */}
          <path
            d="M70 531 C170 581 261 539 361 505 C464 470 535 474 626 504 C704 530 759 540 836 506 C935 462 1027 472 1131 535 C1028 499 953 497 864 534 C770 574 693 576 595 543 C505 513 438 510 355 540 C247 580 160 590 70 531 Z"
            fill="rgba(255,255,255,0.92)"
            stroke="none"
          />
          {/* Wave two */}
          <path
            d="M300 635 C445 661 591 635 737 584 C878 535 1005 520 1130 548 C1025 527 918 554 800 604 C630 676 450 704 300 635 Z"
            fill="rgba(255,255,255,0.6)"
            stroke="none"
          />
        </g>
        {/* Four-point navigation sparkle */}
        <path
          d="M939 26 C950 92 964 105 1030 116 C964 127 950 141 939 207 C928 141 914 127 848 116 C914 105 928 92 939 26 Z"
          fill="#ffffff"
          className="origin-[939px_116px] transition-transform duration-500 group-hover:scale-110"
        />
      </svg>
    </div>

    <span className="text-[18px] font-semibold tracking-[-0.025em] text-[#1d1d1f] dark:text-[#ffffff]">
      Ferry
    </span>
  </div>
);

interface PeerLinkVisualizerProps {
  connected: boolean;
  transferring: boolean;
  connectionMode: ConnectionMode;
  role: 'sender' | 'recipient';
}

export const PeerLinkVisualizer: React.FC<PeerLinkVisualizerProps> = ({
  connected,
  transferring,
  connectionMode,
  role,
}) => {
  const modeLabel =
    connectionMode === 'direct'
      ? 'Direct P2P · Encrypted'
      : connectionMode === 'relayed'
      ? 'TURN Relayed · Encrypted'
      : connected
      ? 'Connected · Encrypted'
      : 'Waiting for Peer';

  return (
    <div className="liquid-glass rounded-[22px] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="relative flex h-11 w-11 items-center justify-center">
            {!connected && (
              <span className="animate-airdrop-ripple absolute inset-0 rounded-full border border-[#0071e3]/45 dark:border-[#2997ff]/45" />
            )}
            <div
              className={`relative flex h-11 w-11 items-center justify-center rounded-full transition-colors ${
                connected
                  ? 'bg-[#0071e3]/15 text-[#0066cc] dark:bg-[#2997ff]/20 dark:text-[#2997ff]'
                  : 'bg-black/[0.05] text-[#7a7a7a] dark:bg-white/[0.08] dark:text-[#cccccc]'
              }`}
            >
              {role === 'sender' ? (
                <Laptop className="h-5 w-5" />
              ) : (
                <Smartphone className="h-5 w-5" />
              )}
            </div>
          </div>
          <div>
            <div className="text-[13px] font-semibold tracking-[-0.01em] text-[#1d1d1f] dark:text-white">
              This Device
            </div>
            <div className="text-[11px] text-[#7a7a7a] dark:text-[#cccccc]/70">
              {role === 'sender' ? 'Sender' : 'Recipient'}
            </div>
          </div>
        </div>

        <div className="relative flex-1 px-2">
          <svg className="h-5 w-full overflow-visible" viewBox="0 0 120 20" preserveAspectRatio="none">
            <line
              x1="4"
              y1="10"
              x2="116"
              y2="10"
              stroke="currentColor"
              strokeWidth="1.75"
              className={
                connected
                  ? 'text-[#0071e3]/30 dark:text-[#2997ff]/30'
                  : 'text-black/[0.08] dark:text-white/[0.12]'
              }
            />
            {connected && (
              <line
                x1="4"
                y1="10"
                x2="116"
                y2="10"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                className={
                  transferring
                    ? 'animate-dash-flow text-[#0071e3] dark:text-[#2997ff]'
                    : 'text-[#34C759] dark:text-[#30D158]'
                }
              />
            )}
          </svg>
          <div className="mt-1 flex items-center justify-center">
            {connected ? (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                  connectionMode === 'relayed'
                    ? 'bg-[#FF9500]/15 text-[#FF9500]'
                    : 'bg-[#34C759]/15 text-[#248A3D] dark:bg-[#30D158]/20 dark:text-[#30D158]'
                }`}
              >
                <Lock className="h-2.5 w-2.5" />
                {modeLabel}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] px-2.5 py-0.5 text-[11px] font-medium text-[#7a7a7a] dark:bg-white/[0.08] dark:text-[#cccccc]">
                <Radio className="h-2.5 w-2.5 animate-pulse text-[#0071e3] dark:text-[#2997ff]" />
                {modeLabel}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[13px] font-semibold tracking-[-0.01em] text-[#1d1d1f] dark:text-white">
              {role === 'sender' ? 'Recipient' : 'Sender'}
            </div>
            <div className="text-[11px] text-[#7a7a7a] dark:text-[#cccccc]/70">
              {connected ? 'Connected' : 'Pending'}
            </div>
          </div>
          <div
            className={`flex h-11 w-11 items-center justify-center rounded-full transition-all ${
              connected
                ? 'bg-[#34C759]/15 text-[#248A3D] dark:bg-[#30D158]/20 dark:text-[#30D158]'
                : 'border border-dashed border-black/15 bg-black/[0.03] text-[#AEAEB2] dark:border-white/20 dark:bg-white/[0.04]'
            }`}
          >
            {role === 'sender' ? (
              <Smartphone className="h-5 w-5" />
            ) : (
              <Laptop className="h-5 w-5" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
