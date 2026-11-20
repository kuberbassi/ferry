import React from 'react';
import { ChevronLeft } from 'lucide-react';

interface LegalPageProps {
  page: 'privacy' | 'terms';
  onBack: () => void;
  onSwitch: (page: 'privacy' | 'terms') => void;
}

export const LegalPage: React.FC<LegalPageProps> = ({ page, onBack, onSwitch }) => {
  return (
    <div className="mx-auto max-w-2xl space-y-6 animate-pop-in">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="liquid-glass-pill inline-flex cursor-pointer items-center gap-1 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-[#007AFF] transition-transform active:scale-[0.97] dark:text-[#38BDF8]"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to Ferry
        </button>

        <div className="flex gap-1 rounded-full bg-black/[0.06] p-1 dark:bg-white/[0.08]">
          <button
            type="button"
            onClick={() => onSwitch('privacy')}
            className={`cursor-pointer rounded-full px-3.5 py-1 text-[12px] font-medium transition-all ${
              page === 'privacy'
                ? 'bg-white text-[#1D1D1F] shadow-xs dark:bg-white/20 dark:text-white'
                : 'text-[#6E6E73] dark:text-[#98989D]'
            }`}
          >
            Privacy
          </button>
          <button
            type="button"
            onClick={() => onSwitch('terms')}
            className={`cursor-pointer rounded-full px-3.5 py-1 text-[12px] font-medium transition-all ${
              page === 'terms'
                ? 'bg-white text-[#1D1D1F] shadow-xs dark:bg-white/20 dark:text-white'
                : 'text-[#6E6E73] dark:text-[#98989D]'
            }`}
          >
            Terms
          </button>
        </div>
      </div>

      <article className="liquid-glass rounded-[28px] p-7 sm:p-10">
        {page === 'privacy' ? (
          <div className="space-y-6 text-[14.5px] leading-[1.65] text-[#424245] dark:text-[#D1D5DB]">
            <header className="border-b border-black/[0.06] pb-5 dark:border-white/[0.08]">
              <h1 className="text-[28px] font-semibold tracking-[-0.025em] text-[#1D1D1F] dark:text-white">
                Privacy Policy
              </h1>
              <p className="mt-1 text-[13px] text-[#6E6E73] dark:text-[#98989D]">
                How Ferry handles your files, connection metadata, and temporary sessions.
              </p>
            </header>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                1. No Permanent File Storage
              </h2>
              <p>
                Ferry does not upload your files to cloud storage or maintain a server-side file
                library. Files are streamed directly from the sender&apos;s browser to the
                recipient&apos;s browser over an encrypted WebRTC data channel (DTLS).
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                2. Temporary Signalling &amp; Network Metadata
              </h2>
              <p>
                To connect two browsers, Ferry&apos;s signalling service temporarily holds minimal
                session metadata in memory: a random session identifier, sender authorization token,
                optional transfer label, expiry policy, and WebRTC connection negotiation data (SDP
                offers, answers, and ICE candidates).
              </p>
              <p>
                Your IP address is processed briefly for rate limiting and peer discovery (STUN).
                Session metadata is deleted automatically when you end the transfer, close the
                sender tab, or reach the configured expiry time.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                3. Relayed Connections (TURN)
              </h2>
              <p>
                When strict firewalls or NAT configurations prevent a direct peer-to-peer route,
                encrypted traffic may pass through a TURN relay server. Relays forward packets in
                transit without writing file contents to permanent storage. Ferry displays whether a
                transfer is direct or relayed.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                4. Link &amp; QR Security
              </h2>
              <p>
                Anyone who has your transfer link or scans your QR code while the session is active
                can request the files you selected. Share links only with intended recipients, and
                end the transfer when finished.
              </p>
            </section>
          </div>
        ) : (
          <div className="space-y-6 text-[14.5px] leading-[1.65] text-[#424245] dark:text-[#D1D5DB]">
            <header className="border-b border-black/[0.06] pb-5 dark:border-white/[0.08]">
              <h1 className="text-[28px] font-semibold tracking-[-0.025em] text-[#1D1D1F] dark:text-white">
                Terms of Use
              </h1>
              <p className="mt-1 text-[13px] text-[#6E6E73] dark:text-[#98989D]">
                Practical expectations, limitations, and responsibilities when using Ferry.
              </p>
            </header>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                1. Sender Availability
              </h2>
              <p>
                Because Ferry does not store your files on a server, the sender&apos;s browser tab
                must remain open and online for the duration of the transfer. Closing the tab,
                sleeping the device, or losing connectivity ends the session immediately.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                2. File Size &amp; Browser Constraints
              </h2>
              <p>
                Ferry streams files in bounded 64 KB chunks and verifies completed files with SHA-256
                checksums. Actual maximum file size and transfer speed depend on your browser,
                available device storage, memory, and network conditions.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                3. Integrity vs. Malware Scanning
              </h2>
              <p>
                SHA-256 verification confirms that received bytes match what the sender transmitted.
                It does not scan files for malware or verify content safety. Recipients should only
                download files from people they trust.
              </p>
            </section>

            <section className="space-y-2">
              <h2 className="text-[16px] font-semibold text-[#1D1D1F] dark:text-white">
                4. Acceptable Use &amp; Rate Limits
              </h2>
              <p>
                You are responsible for the files you share. Do not use Ferry to distribute unlawful
                material or abuse signalling and relay capacity. Automated abuse or excessive
                session creation may be rate-limited.
              </p>
            </section>
          </div>
        )}
      </article>
    </div>
  );
};
