// What answers a page load (docs/offline-mode.md, _what answers a navigation_):
// the network, given a short time to do it, and otherwise this worker's own
// precached copy of the page. Kept out of sw.ts so the decision can be specified
// without a service worker around it.
//
// The network goes first because a reachable origin should always hand over the
// LATEST deploy — that is what lets a deploy replace a page without the worker
// that is installed having to update first. But "reachable" is not the same as
// "answering": a connection that is accepted and then stalls (a captive portal, a
// train, an origin that is up and wedged) leaves the browser waiting on a request
// that neither fails nor finishes, in front of a blank window, while the app is
// sitting whole in the precache. So the network gets `NAVIGATION_TIMEOUT_MS`, and
// after that the device opens what it holds.
//
// Falling back costs little here, which is why the timeout can be short: the
// library is local either way, so the worst outcome of a wrong guess is a page one
// deploy old — and the update pill says so once the new worker arrives.
export const NAVIGATION_TIMEOUT_MS = 3000;

export interface NavigationSources {
  // The network's answer: the navigation preload response, or a fetch.
  network: Promise<Response>;
  // This worker's precached copy of the page, when it holds one.
  precached: () => Promise<Response | undefined>;
  timeoutMs?: number;
}

const TIMED_OUT = Symbol('timed out');
const FAILED = Symbol('failed');

export async function answerNavigation({
  network,
  precached,
  timeoutMs = NAVIGATION_TIMEOUT_MS,
}: NavigationSources): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    network.catch(() => FAILED),
    new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    }),
  ]);
  clearTimeout(timer);

  // The network's answer stands unless the origin itself failed. A 404 is an
  // answer — the page really is not there — and so is a redirect; a 5xx is the
  // origin being broken, which is no reason to withhold a page this device holds.
  if (typeof outcome !== 'symbol' && outcome.status < 500) return outcome;

  const held = await precached().catch(() => undefined);
  if (held) return held;

  // Nothing here to open instead (an unknown path): only the network can answer,
  // with whatever it eventually says — its response, its 5xx, or its failure.
  return typeof outcome === 'symbol' ? network : outcome;
}
