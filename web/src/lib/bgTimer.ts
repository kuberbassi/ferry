/**
 * Unthrottled interval timer backed by a lightweight inline Web Worker.
 * Prevents Chrome/Edge/Safari from throttling background-tab timers to 1000ms
 * when the user switches tabs during a large P2P transfer.
 */
export function createBgInterval(callback: () => void, intervalMs: number): () => void {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    const id = window.setInterval(callback, intervalMs);
    return () => window.clearInterval(id);
  }

  try {
    const code = `
      const id = setInterval(() => postMessage(0), ${Math.max(10, intervalMs)});
      self.onmessage = () => clearInterval(id);
    `;
    const blob = new Blob([code], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    worker.onmessage = () => callback();
    return () => {
      worker.postMessage(1);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = window.setInterval(callback, intervalMs);
    return () => window.clearInterval(id);
  }
}
