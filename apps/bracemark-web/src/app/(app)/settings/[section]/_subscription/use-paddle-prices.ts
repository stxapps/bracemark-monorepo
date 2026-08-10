'use client';

import { queryOptions, useQuery } from '@tanstack/react-query';

import { useApiClient } from '@stxapps/react';
import { type ApiClient, type AvailablePaidPlan, iapPricesEndpoint } from '@stxapps/shared';

import { previewPaddlePrices } from '@/lib/paddle';

// What each on-sale plan costs THIS buyer — their currency, their tax, the
// figure Paddle's overlay will repeat — for the upgrade cards. The Paddle-side
// counterpart of bracemark-expo reading `displayPrice` off a store product.
//
// Two hops, and the split is the design (docs/iap.md, _currency_): the SERVER
// owns which `pri_…` is on sale (the front of PADDLE_PRICE_ID_*, the same id the
// checkout will bill), and PADDLE owns what that price costs here. Neither half
// is guessed locally, and no price ever travels from this client toward a
// charge — `iap/checkout` re-resolves it server-side and ignores anything the
// client might think it knows.
//
// WHY THIS LIVES IN THE APP, not beside `useSubscriptionStatus` in
// @stxapps/react where the other IAP query lives: it calls `previewPaddlePrices`
// from `lib/paddle.ts`, which is app code on purpose (bracemark-web is the only
// Paddle checkout surface). A package importing an app is forbidden by the Nx
// `type:` boundaries and fails `npm run lint`, so the shape can't be shared even
// though it would like to be.
//
// Running this hook is also what first loads Paddle.js, which makes it the
// answer to a PUBLISHED claim: bracemark-site's /privacy and its FAQ _trackers_
// entry both say the app loads exactly one third-party script and that it
// arrives when you open Settings → Subscription. Calling this from another
// screen falsifies both pages.

// Export-and-reuse, the `subscriptionStatusQueryOptions` pattern: hook and any
// future imperative `fetchQuery` share one cache entry.
export function paddlePricesQueryOptions(client: ApiClient) {
  return queryOptions({
    queryKey: ['iap', 'prices', 'preview'] as const,
    queryFn: async ({ signal }) => {
      const { prices } = await client.call(iapPricesEndpoint, {}, { signal });
      // `signal` reaches the API call but NOT Paddle's SDK, which takes no
      // AbortSignal — a cancelled query lets that request finish and discards
      // the result. Harmless (it writes nothing), and no worse than the manual
      // `canceled` flag this replaced, which also couldn't stop it.
      const totals = await previewPaddlePrices(prices.map((p) => p.priceId));

      const byPlan: Partial<Record<AvailablePaidPlan, string>> = {};
      for (const { plan, priceId } of prices) {
        const total = totals[priceId];
        if (total) byPlan[plan] = total;
      }
      return byPlan;
    },
    // A price is near-static, so this is mostly about not re-running the whole
    // two-hop lookup (and re-invoking Paddle.js) every time the user navigates
    // back into Settings. Finite rather than Infinity on purpose: a price
    // rotation — moving a new `pri_…` to the front of the env list — should
    // reach an already-open tab within a few minutes rather than never, since
    // until it does the card previews one price and the checkout bills another.
    staleTime: 5 * 60_000,
    // Display-only data whose fallback (the USD base price) is already correct
    // and already rendered. Three backed-off retries against a third-party SDK
    // buys a nicer number at a cost nobody asked for.
    retry: false,
  });
}

// `enabled` is the caller's: the cards only render on the free plan, and the
// lookup should not run — nor Paddle.js load — for a subscriber who will never
// see them.
export function usePaddlePrices(options: { enabled: boolean }) {
  const client = useApiClient();
  return useQuery({ ...paddlePricesQueryOptions(client), enabled: options.enabled });
}
