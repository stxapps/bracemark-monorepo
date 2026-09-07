import { CheckoutEventNames, initializePaddle, type Paddle } from '@paddle/paddle-js';

// App-level Paddle Billing wrapper — bracemark-web is the ONLY checkout surface
// (the extension deep-links here; the future Expo app uses store IAP), so this
// lives in the app, not a package. It wraps @paddle/paddle-js with:
//  - a lazy singleton: Paddle.js is a third-party script, loaded only when the
//    subscription section actually needs it, never on app boot. WHEN that is has
//    a published answer: bracemark-site's /privacy and its FAQ _trackers_ entry
//    both say this is the one third-party script the app loads, and that it
//    arrives when you open Settings → Subscription — which is now true via
//    previewPaddlePrices below, not only at checkout. Loading it anywhere else
//    falsifies those pages;
//  - the checkout lifecycle callbacks the subscription UI cares about, routed
//    from Paddle's global eventCallback (registered once at initialization) to
//    the currently-open checkout's handlers.
//
// The checkout itself opens on a SERVER-created transaction id (POST
// /v1/iap/checkout): the server stamps the account binding (custom_data.userId)
// and the price — see the contract note in @stxapps/shared iap/endpoints.ts.
// Payment completion reaches bracemark-api via Paddle's webhook, NOT this client;
// the UI just polls `iap/status` after `onCompleted` until the plan flips.
//
// NEXT_PUBLIC_PADDLE_ENV / NEXT_PUBLIC_PADDLE_CLIENT_TOKEN are bundler-inlined
// per tier (see .env.*; client tokens are public by design). The literal
// `process.env.…` access must stay here in app code for Next to inline it.

let paddlePromise: Promise<Paddle | undefined> | null = null;

// The open checkout's handlers. Paddle's eventCallback is global (bound once at
// init), so the per-open callbacks are held here; only one overlay checkout can
// be open at a time.
let onCompleted: (() => void) | null = null;
let onClosed: (() => void) | null = null;

function getPaddle(): Promise<Paddle | undefined> {
  if (!paddlePromise) {
    const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
    if (!token) throw new Error('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set');

    paddlePromise = initializePaddle({
      environment: process.env.NEXT_PUBLIC_PADDLE_ENV === 'production' ? 'production' : 'sandbox',
      token,
      eventCallback: (event) => {
        if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) onCompleted?.();
        // `closed` fires for BOTH outcomes — after completion and on abandon —
        // so the UI treats it as "overlay gone", not "purchase canceled".
        if (event.name === CheckoutEventNames.CHECKOUT_CLOSED) onClosed?.();
      },
    });
  }
  return paddlePromise;
}

// The buyer's OWN price for a set of catalog ids — what `Paddle.PricePreview`
// is for, and the Paddle-side counterpart of bracemark-expo reading
// `displayPrice` off a store product. With no address supplied Paddle
// geolocates by IP and applies whatever the catalog says for that country: a
// per-currency price if we set one, the base currency if we did not — Paddle
// Billing has no exchange-rate conversion, a country is either priced or it is
// billed the base (docs/iap.md, _currency_) — plus that country's tax. So
// `formattedTotals.total` is the charge, localized and symbol-formatted
// already, and it is the same figure the overlay will show.
//
// Keyed by price id on the way out because the caller holds ids, not plans: the
// plan → `pri_…` mapping belongs to the server (GET /v1/iap/prices) and this
// file deliberately never learns it.
//
// An ESTIMATE, and the caller has to treat it as one. Paddle resolves the real
// country from the customer's address or card at checkout, which an IP guess can
// miss — a VPN, or a saved Paddle address in another country — and only the
// overlay's number binds. What it cannot do is change what anyone pays: the
// transaction is created server-side from the server's own price id, and no
// price crosses the wire from here.
export async function previewPaddlePrices(priceIds: string[]): Promise<Record<string, string>> {
  if (priceIds.length === 0) return {};

  const paddle = await getPaddle();
  if (!paddle) throw new Error('Paddle failed to initialize');

  const preview = await paddle.PricePreview({
    items: priceIds.map((priceId) => ({ priceId, quantity: 1 })),
  });

  const totals: Record<string, string> = {};
  for (const item of preview.data.details.lineItems) {
    totals[item.price.id] = item.formattedTotals.total;
  }
  return totals;
}

// Open the overlay checkout for a server-created transaction. `onCompleted`
// fires when payment succeeds (start polling `iap/status`); `onClosed` when the
// overlay goes away for any reason (clear busy state).
export async function openPaddleCheckout(options: {
  transactionId: string;
  onCompleted: () => void;
  onClosed: () => void;
}): Promise<void> {
  const paddle = await getPaddle();
  if (!paddle) throw new Error('Paddle failed to initialize');

  onCompleted = options.onCompleted;
  onClosed = options.onClosed;
  paddle.Checkout.open({ transactionId: options.transactionId });
}
