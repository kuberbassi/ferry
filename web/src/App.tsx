import React, { useEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { Download, Moon, Sun } from 'lucide-react';
import { FerryLogo } from './components/FerryLogo';
import { SenderView } from './components/SenderView';
import { RecipientView } from './components/RecipientView';
import { LegalPage } from './components/LegalPages';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type ActiveRoute =
  | { kind: 'sender' }
  | { kind: 'recipient'; sessionId: string }
  | { kind: 'legal'; page: 'privacy' | 'terms' };

function getInitialRoute(): ActiveRoute {
  const params = new URLSearchParams(window.location.search);
  const s = params.get('s');
  if (s && s.trim().length > 0) {
    return { kind: 'recipient', sessionId: s.trim() };
  }
  const p = params.get('p');
  if (p === 'privacy' || p === 'terms') {
    return { kind: 'legal', page: p };
  }
  return { kind: 'sender' };
}

export const App: React.FC = () => {
  const [route, setRoute] = useState<ActiveRoute>(getInitialRoute);
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return (
      localStorage.getItem('ferry_theme') === 'dark' ||
      (!localStorage.getItem('ferry_theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    );
  });

  const navRef = useRef<HTMLDivElement>(null);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onAppInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, []);

  const handleInstallApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') {
      setInstallPrompt(null);
    }
  };

  useEffect(() => {
    const root = document.documentElement;
    if (dark) {
      root.classList.add('dark');
      localStorage.setItem('ferry_theme', 'dark');
    } else {
      root.classList.remove('dark');
      localStorage.setItem('ferry_theme', 'light');
    }
  }, [dark]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      if (navRef.current) {
        gsap.fromTo(
          navRef.current,
          { y: -12, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.6, ease: 'power3.out' }
        );
      }
    });
    return () => ctx.revert();
  }, []);

  const navigateHome = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('s');
    url.searchParams.delete('p');
    window.history.replaceState({}, '', url.toString());
    setRoute({ kind: 'sender' });
  };

  const navigateLegal = (page: 'privacy' | 'terms') => {
    const url = new URL(window.location.href);
    url.searchParams.delete('s');
    url.searchParams.set('p', page);
    window.history.replaceState({}, '', url.toString());
    setRoute({ kind: 'legal', page });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-[#f5f5f7] text-[#1d1d1f] transition-colors duration-300 dark:bg-[#050814] dark:text-[#ffffff]">
      {/* GPU-light Radial Aurora Backdrop (no expensive offscreen blur passes) */}
      <div className="aurora-backdrop pointer-events-none fixed inset-0" />

      {/* Minimal Floating Liquid Glass Navbar */}
      <header className="sticky top-0 z-30 mx-auto w-full max-w-[980px] px-4 pt-5 sm:px-6">
        <div
          ref={navRef}
          className="liquid-glass flex items-center justify-between rounded-full px-4 py-2.5 sm:px-5"
        >
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigateHome();
            }}
            className="focus:outline-none"
          >
            <FerryLogo />
          </a>

          <div className="flex items-center gap-5">
            <nav className="apple-nav-link hidden items-center gap-5 font-normal text-[#333333] sm:flex dark:text-[#cccccc]">
              <button
                type="button"
                onClick={() => navigateLegal('privacy')}
                className="cursor-pointer transition-colors hover:text-[#1d1d1f] dark:hover:text-white"
              >
                Privacy
              </button>
              <button
                type="button"
                onClick={() => navigateLegal('terms')}
                className="cursor-pointer transition-colors hover:text-[#1d1d1f] dark:hover:text-white"
              >
                Terms
              </button>
            </nav>

            {installPrompt && (
              <button
                type="button"
                onClick={handleInstallApp}
                title="Install Ferry as an app"
                className="liquid-glass-pill inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium text-[#1d1d1f] transition-transform active:scale-95 dark:text-white"
              >
                <Download className="h-3.5 w-3.5 text-[#0066cc] dark:text-[#2997ff]" />
                Install
              </button>
            )}

            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              aria-label="Toggle appearance"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-black/[0.05] text-[#1d1d1f] transition-all hover:scale-105 hover:bg-black/[0.09] active:scale-95 dark:bg-white/[0.1] dark:text-white dark:hover:bg-white/[0.16]"
            >
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 mx-auto w-full max-w-[980px] flex-1 px-4 pb-16 pt-10 sm:px-6">
        {route.kind === 'recipient' ? (
          <RecipientView sessionId={route.sessionId} onExitToSender={navigateHome} />
        ) : route.kind === 'legal' ? (
          <LegalPage
            page={route.page}
            onBack={navigateHome}
            onSwitch={(page) => navigateLegal(page)}
          />
        ) : (
          <SenderView />
        )}
      </main>

      {/* Clean Apple-style Footer */}
      <footer className="relative z-10 mx-auto flex w-full max-w-[980px] flex-wrap items-center justify-between gap-4 border-t border-black/[0.06] px-4 py-6 text-[12px] text-[#7a7a7a] sm:px-6 dark:border-white/[0.08] dark:text-[#cccccc]/70">
        <span>Ferry · Direct file transfer</span>
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={() => navigateLegal('privacy')}
            className="cursor-pointer transition-colors hover:text-[#1d1d1f] dark:hover:text-white"
          >
            Privacy Policy
          </button>
          <button
            type="button"
            onClick={() => navigateLegal('terms')}
            className="cursor-pointer transition-colors hover:text-[#1d1d1f] dark:hover:text-white"
          >
            Terms of Use
          </button>
        </div>
      </footer>
    </div>
  );
};

export default App;
