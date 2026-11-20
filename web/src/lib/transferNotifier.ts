import { formatBytes, formatEta, formatSpeed } from './protocol';

const DEFAULT_TITLE = 'Ferry - Big files. One scan. Zero storage.';
const NOTIFICATION_TAG = 'ferry-transfer-progress';

let lastNotifyTs = 0;
let wakeLockSentinel: WakeLockSentinel | null = null;

export async function requestNotificationPermission(): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    await Notification.requestPermission().catch(() => {});
  }
}

export async function acquireWakeLock(): Promise<void> {
  try {
    if ('wakeLock' in navigator && !wakeLockSentinel) {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
      wakeLockSentinel.addEventListener('release', () => {
        wakeLockSentinel = null;
      });
    }
  } catch {
    // Ignore unsupported or battery-saver restrictions
  }
}

export async function releaseWakeLock(): Promise<void> {
  try {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch {
    wakeLockSentinel = null;
  }
}

async function showSystemNotification(
  title: string,
  body: string,
  silent: boolean
): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const options: NotificationOptions = {
    body,
    tag: NOTIFICATION_TAG,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    silent,
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.showNotification(title, options);
        return;
      }
    }
    new Notification(title, options);
  } catch {
    // Fallback ignored if platform blocks Notification constructor
  }
}

export function updateTransferNotification(params: {
  role: 'sender' | 'recipient';
  transferredBytes: number;
  totalBytes: number;
  speedBps: number;
  completed?: boolean;
}): void {
  const { role, transferredBytes, totalBytes, speedBps, completed } = params;
  const verb = role === 'sender' ? 'Sending' : 'Downloading';

  if (completed) {
    document.title = `Done · Ferry`;
    if (document.hidden) {
      showSystemNotification(
        'Ferry · Transfer Complete',
        `${formatBytes(totalBytes)} verified with SHA-256`,
        false
      );
    }
    return;
  }

  const pct =
    totalBytes > 0 ? Math.min(99, Math.round((transferredBytes / totalBytes) * 100)) : 0;
  document.title = `${pct}% · ${verb} · Ferry`;

  if (!document.hidden) return;

  const now = performance.now();
  if (now - lastNotifyTs < 2000) return;
  lastNotifyTs = now;

  const remaining = Math.max(0, totalBytes - transferredBytes);
  const eta = formatEta(remaining, speedBps);
  const speed = formatSpeed(speedBps);

  showSystemNotification(
    `Ferry · ${verb} ${pct}% (${speed})`,
    `${formatBytes(transferredBytes)} of ${formatBytes(totalBytes)} · ${eta} left`,
    true
  );
}

export async function clearTransferNotification(): Promise<void> {
  document.title = DEFAULT_TITLE;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        const list = await reg.getNotifications({ tag: NOTIFICATION_TAG });
        list.forEach((n) => n.close());
      }
    }
  } catch {
    // Ignore
  }
}
