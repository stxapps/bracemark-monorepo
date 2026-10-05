// Asks the browser to check for a new service worker when a long-lived window
// comes back to the foreground (docs/offline-mode.md, _when the browser checks for
// a new build_).
//
// The browser checks `/sw.js` by itself on every NAVIGATION in scope, and that is
// the path every update normally takes. But Next's router moves between routes
// with the History API, which is not a navigation — so a window that is opened
// once and never reloaded (an installed app left running for weeks) never checks
// again, and stays on the build it loaded however many deploys go by. Returning to
// the window is the one moment such a window reliably has, so that is the trigger.
//
// At most once per interval, counted from the load: the load was itself a check.
// Offline is skipped WITHOUT spending the interval, so the next return online
// still checks. A check that finds a new build needs nothing more from here — the
// new worker takes over at once (sw.ts) and UpdatePill hears `controllerchange`.
export const SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function watchForServiceWorkerUpdates(): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;

  let lastCheck = Date.now();
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    if (navigator.onLine === false) return;
    const now = Date.now();
    if (now - lastCheck < SERVICE_WORKER_UPDATE_CHECK_INTERVAL_MS) return;
    lastCheck = now;
    // No registration (never signed in, or development) is nothing to check; a
    // failed check — the origin unreachable — is the browser's to retry on the
    // next navigation.
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.update())
      .catch(() => undefined);
  };

  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}
