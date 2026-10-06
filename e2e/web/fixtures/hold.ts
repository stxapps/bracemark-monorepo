import { type Page, type Request } from '@playwright/test';

// Hold ONE of a page's requests back, and let it go on command — a single slow
// round trip, made to order.
//
// This is what the sync races need and nothing coarser will do. They are not
// about a slow NETWORK: under a uniform delay every client slows down together
// and the order of arrivals never changes. They are about one transfer of one
// client staying out while ANOTHER client (a second device, a second tab) gets a
// whole cycle in — a commit that lands just after someone else's, an upload that
// lands just after a newer one. Holding one request, on one page, is exactly that
// and no more: the page's other traffic and every other page's goes through
// untouched, so whatever the other client does in the meantime it does unaided.
//
// Nothing in the app is replaced or stubbed. The held request is the app's own,
// and it is released unmodified — it reaches the real api with the body the app
// built. Only its timing is ours.
export interface HeldRequest {
  // Resolves, with the request, once it has left the page and is being held.
  reached: Promise<Request>;
  // Let it through. Safe to call twice, and safe after the page is gone.
  release(): Promise<void>;
}

export async function holdNextRequest(
  page: Page,
  url: string | RegExp,
  // Narrow the match past what a URL pattern can say — the method, most often.
  matches: (request: Request) => boolean = () => true,
): Promise<HeldRequest> {
  let onReached!: (request: Request) => void;
  const reached = new Promise<Request>((resolve) => (onReached = resolve));
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));

  // The FIRST match only: a retry or a later cycle's request of the same shape
  // must go straight through, or releasing one would just hold the next.
  let taken = false;
  await page.route(url, async (route) => {
    const request = route.request();
    if (taken || !matches(request)) {
      await route.fallback();
      return;
    }
    taken = true;
    onReached(request);
    await gate;
    // A page closed while its request was held has no route left to continue;
    // that is the case ending, not a failure of it.
    await route.continue().catch(() => undefined);
  });

  return {
    reached,
    async release() {
      open();
    },
  };
}

// How many requests whose URL contains `fragment` a page has sent so far — read
// as a function, so a case can take the count at two moments and compare. For the
// claim "this tab did NOT do X while that one was busy", which has no element to
// wait for.
export function countRequests(page: Page, fragment: string): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.url().includes(fragment)) count += 1;
  });
  return () => count;
}
