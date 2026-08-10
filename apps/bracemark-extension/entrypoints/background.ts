/**
 * Background service worker — the privileged core of the extension.
 *
 * MV3 service workers are EPHEMERAL (no long-running loop), so the recurring work
 * is driven by a `browser.alarms` tick rather than a timer:
 *   - on each alarm (and on startup) it runs a SYNC cycle (`runSync`): a selective
 *     sync materializing only links/ + extractions/. There is NO background
 *     extraction sweep here — the extension is active-context only (no `<all_urls>`
 *     host grant), so it never bg-fetches saved URLs; the bg-fetch residual is owned
 *     by the deferred `bracemark-extractor` (docs/link-extraction.md "the extension is
 *     active-context only").
 *   - it answers the typed popup → background message protocol, owning ALL
 *     privileged / CORS-exempt work: KICK_SYNC (run a cycle now) and EXTRACT (capture
 *     a facet from the active tab + write back). Reading sync status is NOT a message —
 *     the popup/options read the browser.storage.local mirror (mirrored-sync-state.ts) directly.
 *
 * The popup never fetches bracemark-api or touches a tab directly — it sends a message
 * and renders the result.
 */

import { getSession, loadSession } from '@stxapps/web-react';

import { runExtraction } from '@/utils/extraction-worker';
import type { ExtensionMessage, MessageResponses } from '@/utils/messages';
import { runSync } from '@/utils/sync-runner';

const SYNC_ALARM = 'bracemark-sync';
// The alarm drives the NETWORK SYNC POLL (`ops/list`, to discover other devices'
// changes). Nothing is on the critical path here (the saving client already
// extracted), so this is the idle CEILING the doc prescribes — ~1h, not a fast tick
// that spends a request a minute to almost always find nothing. Freshness rides cheap
// local wake triggers instead (worker startup below, KICK_SYNC from the popup,
// post-EXTRACT sync). See docs/link-extraction.md "the queue is a query".
const SYNC_PERIOD_MINUTES = 60;

// `${linkId}:${facet}` for every capture running right now — see the EXTRACT handler.
const extractionsInFlight = new Set<string>();

export default defineBackground(() => {
  // Periodic sync. `create` with the same name is idempotent across restarts.
  browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_PERIOD_MINUTES });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) void withSession(runSync);
  });

  // Kick one cycle as the worker spins up (on install / browser start / wake).
  void withSession(runSync);

  browser.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
    withSession(() => handle(message)).then(sendResponse, (err: unknown) =>
      sendResponse({ ok: false, error: errorMessage(err) }),
    );
    // Keep the channel open for the async response.
    return true;
  });
});

// Hydrate the in-memory session mirror before any trigger's work runs. This is
// THE single hydration point for the worker — the analog of the popup's
// AuthProvider. The worker is a separate JS context from the popup (which OWNS
// the session: sign-in/out, token refresh), and the two share state only through
// IndexedDB, so the worker's mirror goes stale unless it re-reads on every
// trigger. Gating the three entry points (alarm, startup, message) here lets the
// leaf handlers (runSync/buildDeps, handle/currentUsername) be pure synchronous
// getSession() readers — a new message op can't reintroduce the cold-worker
// "no token" bug by forgetting to load, because it never holds that duty.
async function withSession<T>(run: () => Promise<T>): Promise<T> {
  await loadSession();
  return run();
}

async function handle(
  message: ExtensionMessage,
): Promise<MessageResponses[ExtensionMessage['type']]> {
  switch (message.type) {
    case 'KICK_SYNC':
      await runSync();
      return { ok: true };

    case 'EXTRACT': {
      const username = currentUsername();
      if (!username) return { ok: false, error: 'Not signed in' };

      // One run per link+facet at a time. Messages are handled concurrently (the listener
      // dispatches and returns), so a double-clicked screenshot button — or a save whose
      // auto-extract overlaps a manual one — would otherwise run the capture twice. What
      // that costs is more than a wasted capture: both runs reach `writeFile`, each writes
      // a `files/` blob, the second `extractions/` write wins, and the loser's blob is left
      // referenced by nothing — synced, charged against the byte quota, never reclaimed.
      // (The expo drain guards the same hazard with `inFlightPathsRef`.)
      //
      // In-memory and released in a `finally`, never persisted: a mark that outlived its
      // run — a killed service worker, a torn-down popup — would strand the facet where no
      // path looks at it again. Cross-DEVICE duplication stays unguarded on purpose
      // (docs/link-extraction.md — the extraction entity: self-healing, and a lease would
      // cost a write-then-sync on the critical path).
      const inFlightKey = `${message.linkId}:${message.facet}`;
      if (extractionsInFlight.has(inFlightKey)) return { ok: true };
      extractionsInFlight.add(inFlightKey);
      try {
        await runExtraction(username, message.linkId, message.facet);
      } finally {
        extractionsInFlight.delete(inFlightKey);
      }
      // Push the freshly written files/links to the server (and pull anything new).
      void runSync();
      return { ok: true };
    }
  }
}

function currentUsername(): string | null {
  // Synchronous read of the in-memory mirror — withSession already re-hydrated it
  // from IndexedDB before dispatching this message.
  return getSession()?.username ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
