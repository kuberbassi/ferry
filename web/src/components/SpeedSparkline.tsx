import React from 'react';
import { formatBytes, formatEta, formatSpeed } from '../lib/protocol';

interface SpeedSparklineProps {
  speedBps: number;
  history: number[];
  transferredBytes: number;
  totalBytes: number;
}

export const SpeedSparkline: React.FC<SpeedSparklineProps> = ({
  speedBps,
  history,
  transferredBytes,
  totalBytes,
}) => {
  const remaining = Math.max(0, totalBytes - transferredBytes);
  const pct = totalBytes > 0 ? Math.min(100, (transferredBytes / totalBytes) * 100) : 0;

  const points = history.length > 1 ? history : [0, speedBps];
  const maxVal = Math.max(...points, 1024);
  const width = 180;
  const height = 36;

  const coords = points.map((val, idx) => {
    const x = (idx / Math.max(1, points.length - 1)) * width;
    const y = height - (val / maxVal) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const linePath = `M ${coords.join(' L ')}`;
  const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;

  return (
    <div className="liquid-glass rounded-[24px] p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <div>
            <div className="text-[11px] font-medium text-[#6E6E73] dark:text-[#98989D]">
              Transfer Speed
            </div>
            <div className="tabular-nums text-[19px] font-semibold tracking-[-0.02em] text-[#1D1D1F] dark:text-[#F5F5F7]">
              {formatSpeed(speedBps)}
            </div>
          </div>

          <div className="h-7 w-px bg-black/[0.08] dark:bg-white/[0.12]" />

          <div>
            <div className="text-[11px] font-medium text-[#6E6E73] dark:text-[#98989D]">
              Remaining
            </div>
            <div className="tabular-nums text-[19px] font-semibold tracking-[-0.02em] text-[#1D1D1F] dark:text-[#F5F5F7]">
              {formatEta(remaining, speedBps)}
            </div>
          </div>

          <div className="hidden h-7 w-px bg-black/[0.08] sm:block dark:bg-white/[0.12]" />

          <div className="hidden sm:block">
            <div className="text-[11px] font-medium text-[#6E6E73] dark:text-[#98989D]">
              Transferred
            </div>
            <div className="tabular-nums text-[14px] font-medium text-[#1D1D1F] dark:text-[#F5F5F7]">
              {formatBytes(transferredBytes)}{' '}
              <span className="text-[#6E6E73] dark:text-[#98989D]">
                of {formatBytes(totalBytes)}
              </span>
            </div>
          </div>
        </div>

        <svg
          width={width}
          height={height}
          className="overflow-visible text-[#007AFF] dark:text-[#38BDF8]"
        >
          <defs>
            <linearGradient id="appleSparkGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#appleSparkGrad)" />
          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#007AFF] to-[#38BDF8] transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
};
