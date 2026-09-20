// Fails when one tier's Paddle catalog no longer agrees with the config this repo
// ships — the half of the IAP contract that lives in a dashboard, not in git.
//
//   npm run check:paddle                    # development (the sandbox account)
//   npm run check:paddle -- staging
//   npm run check:paddle -- production --yes
//   npm run check:paddle -- --no-checkout   # skip the transaction leg (read-only)
//
// WHY THIS EXISTS. Everything about a Paddle purchase that is OURS is already
// pinned by vitest: the webhook's HMAC and replay window, log-and-ACK, the
// purchases upsert's three in-SQL guards, the fold, the missed-webhook recovery
// (apps/bracemark-api routes/iap.spec.ts, services/iap.spec.ts, lib/paddle.spec.ts).
// What no local test can see is the OTHER half of the same flow: a price id in
// wrangler.jsonc that no longer names a live price, a product whose tax category
// was reset when it was re-created, and the account-level default payment link —
// three pieces of dashboard state that fail SILENTLY until a real customer clicks
// upgrade and gets a 502 (docs/iap.md, _config per env_ and _the payment link_).
//
// It is a `check:` script rather than a spec on purpose. It needs the network and
// a real API key, so it can neither live in `npm run test` (cached, offline, no
// secrets) nor in `e2e/` (a browser and a device the question doesn't involve).
// It is the same shape as check-assets.ts one boundary over: recompute what the
// repo claims, ask the thing that actually holds it, and diff.
//
// WHAT IT DELIBERATELY DOES NOT DO: buy anything. Driving Paddle's overlay means
// driving a third-party iframe, a sandbox card and a webhook round trip, and it
// leaves a live subscription behind that the next run's `already_subscribed` 409
// trips over. That leg stays a manual release check (docs/iap.md, _exercising
// Paddle locally_). The transaction created below is never paid — it is minted to
// read `checkout.url` off it, then canceled.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { AVAILABLE_CADENCES, AVAILABLE_PAID_PLANS, PAID_PLANS } from '@stxapps/shared';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TIERS = ['development', 'staging', 'production'] as const;
type Tier = (typeof TIERS)[number];

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// --- the inputs ------------------------------------------------------------

/**
 * One `"NAME": "value"` pair out of ONE env block of bracemark-api's wrangler.jsonc.
 * The block matters: all three tiers declare the same var names, and two of them
 * point at the same sandbox host — a file-wide regex would take whichever came
 * first and be right by luck. Scoped by the 4-space-indented tier key, the same
 * "read one value out of one named block" move check-assets.ts makes over CSS.
 *
 * Matching the quoted PAIR rather than stripping comments first is what keeps this
 * honest around `"PADDLE_API_BASE": "https://sandbox-api.paddle.com"` — a naive
 * `//` strip eats the value, and no comment in that file spells a key this way.
 */
function workerVar(tier: Tier, name: string): string | undefined {
  const source = read('apps/bracemark-api/wrangler.jsonc');
  const start = source.indexOf(`\n    "${tier}": {`);
  if (start === -1) throw new Error(`no "${tier}" env block in wrangler.jsonc`);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\n    "', 1);
  const block = end === -1 ? rest : rest.slice(0, end);

  const match = block.match(new RegExp(`"${name}":\\s*"([^"]*)"`));
  return match ? match[1] : undefined;
}

/** A committed frontend env value — here, the tier's app origin. */
function webEnv(tier: Tier, name: string): string | undefined {
  const match = read(`apps/bracemark-web/.env.${tier}`).match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

/**
 * The COMMA-SEPARATED price list for a plan — every price it may be billed at, the
 * one on sale first. Mirrors `paddlePriceIds` in bracemark-api services/iap.ts;
 * duplicated rather than imported because that module is a Worker's, typed against
 * `Bindings` and hono, and a tools script must not reach into an app's graph.
 */
function priceIds(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * The tier's Paddle API key. The shell first, then the login keychain — and from a
 * file in this worktree for `development` ONLY, because `.dev.vars` is where
 * `wrangler dev` itself reads the same sandbox key from.
 *
 * The deploy tiers have no such file and must not grow one: a live Paddle key can
 * issue refunds and read every customer, so it belongs in the keychain exactly like
 * the per-tier Cloudflare token (tools/scripts/deploy-worker.sh, docs/env-files.md
 * — _what's committed vs ignored_). There is deliberately no fallback past this.
 */
function resolveApiKey(tier: Tier): { key: string; from: string } {
  const fromShell = process.env.PADDLE_API_KEY;
  if (fromShell) return { key: fromShell, from: 'the shell (PADDLE_API_KEY)' };

  const service = `bracemark-paddle-key-${tier}`;
  try {
    const key = execFileSync(
      'security',
      ['find-generic-password', '-a', 'bracemark', '-s', service, '-w'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (key) return { key, from: `the keychain (${service})` };
  } catch {
    // No keychain, or no such item — fall through to the per-tier answer below.
  }

  if (tier === 'development') {
    const match = read('apps/bracemark-api/.dev.vars').match(/^PADDLE_API_KEY=(.*)$/m);
    const key = match?.[1].trim().replace(/^["']|["']$/g, '');
    if (key) return { key, from: 'apps/bracemark-api/.dev.vars' };
    throw new Error(
      'no PADDLE_API_KEY in the shell, the keychain, or apps/bracemark-api/.dev.vars.\n' +
        'That file is what `wrangler dev` reads too — see docs/env-files.md.',
    );
  }

  throw new Error(
    `no PADDLE_API_KEY for ${tier}. Add this tier’s key to the login keychain with:\n` +
      `  security add-generic-password -a bracemark -s ${service} -w\n` +
      'It needs price.read, product.read and transaction.write. Never put it in a file here.',
  );
}

// --- the checks ------------------------------------------------------------

const failures: string[] = [];
const notes: string[] = [];
const fail = (what: string, detail: string) => failures.push(`${what}\n    ${detail}`);

type PaddlePrice = {
  id: string;
  type?: string;
  status?: string;
  tax_mode?: string;
  billing_cycle?: { interval?: string; frequency?: number } | null;
  unit_price?: { amount?: string; currency_code?: string };
  product?: { id?: string; name?: string; status?: string; tax_category?: string };
};

/** The cadence on sale, as Paddle spells a billing cycle. */
const CADENCE_INTERVAL: Record<string, { interval: string; frequency: number }> = {
  yearly: { interval: 'year', frequency: 1 },
  monthly: { interval: 'month', frequency: 1 },
};

class PaddleError extends Error {}

async function paddle<T>(
  base: string,
  key: string,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; data?: T; error?: { code?: string; detail?: string } }> {
  let res: Response;
  try {
    res = await fetch(`${base}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    // Transport, not config — the difference between "your catalog is wrong" and
    // "this machine is offline", and the caller must not report one as the other.
    throw new PaddleError(`could not reach ${base}: ${(e as Error).message}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new PaddleError(
      `Paddle ${res.status} on ${method} ${pathname} — the key is rejected or lacks a ` +
        'permission (price.read, product.read, transaction.write).',
    );
  }

  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; detail?: string };
  };
  return { status: res.status, data: json.data, error: json.error };
}

/** One configured price id, against the catalog that has to back it. */
async function checkPrice(
  base: string,
  key: string,
  plan: string,
  id: string,
  onSale: boolean,
): Promise<void> {
  const where = `${plan} price ${id}${onSale ? ' (on sale)' : ' (retired, read-side only)'}`;
  const { status, data, error } = await paddle<PaddlePrice>(
    base,
    key,
    'GET',
    `/prices/${encodeURIComponent(id)}?include=product`,
  );

  if (status === 404 || !data) {
    fail(
      where,
      status === 404
        ? 'Paddle does not know this price. A subscriber billed at it is dropped as ' +
            '`unknown_price` — permanently, since the webhook is ACKed.'
        : `Paddle answered ${status}${error?.detail ? `: ${error.detail}` : ''}`,
    );
    return;
  }

  // An ARCHIVED price is fine on the read side and fatal on the write side: the
  // checkout sells the front of the list, and Paddle refuses to bill an archived
  // price. Everything after this is about the price we actually sell.
  if (data.status !== 'active') {
    if (onSale) fail(where, `status is \`${data.status}\` — the checkout cannot sell it`);
    return;
  }
  if (!onSale) return;

  if (data.type !== 'standard') {
    fail(where, `type is \`${data.type}\` — a non-catalog price is not reusable across checkouts`);
  }

  // docs/iap.md, _config per env_: every price carries its own tax_mode rather than
  // inheriting the account default, and omitting it inherits with no error.
  if (data.tax_mode !== 'location') {
    fail(
      where,
      `tax_mode is \`${data.tax_mode}\`, not \`location\` — it is inheriting the account ` +
        'default, which nothing else reports.',
    );
  }

  // Same shape of silent default one level up: `saas` vs `standard` are taxed
  // differently in some jurisdictions, and the sandbox's Plus product was created
  // as `standard` once already.
  const product = data.product;
  if (!product) {
    fail(where, 'no product came back with `include=product` — the key may lack product.read');
  } else {
    if (product.tax_category !== 'saas') {
      fail(where, `product tax_category is \`${product.tax_category}\`, not \`saas\``);
    }
    if (product.status !== 'active') {
      fail(where, `product \`${product.name}\` is \`${product.status}\``);
    }
  }

  // A one-time price sold where a subscription is expected produces a payment and
  // never a `subscription.created`, so nothing ever entitles the account.
  const [cadence] = AVAILABLE_CADENCES;
  const want = CADENCE_INTERVAL[cadence];
  const cycle = data.billing_cycle;
  if (!cycle) {
    fail(where, 'no billing_cycle — this is a one-time price, and the flow expects a subscription');
  } else if (cycle.interval !== want.interval || cycle.frequency !== want.frequency) {
    fail(
      where,
      `billing cycle is every ${cycle.frequency} ${cycle.interval}, but the cadence on sale ` +
        `is \`${cadence}\` (every ${want.frequency} ${want.interval})`,
    );
  }

  const price = data.unit_price;
  notes.push(
    `${plan}: ${id} — ${price?.amount ?? '?'} ${price?.currency_code ?? ''} / ` +
      `${cycle?.interval ?? 'one-time'}, ${product?.name ?? '?'}`,
  );
}

/**
 * The default-payment-link leg. It is its own check because the failure it catches
 * belongs to the ACCOUNT, not to any price: with no default payment link set,
 * `POST /transactions` fails outright (`transaction_default_checkout_url_not_set`)
 * and every checkout 502s — and with one set to the wrong PATH, the email link a
 * dunning subscriber gets opens the app's links page with the `_ptxn` dropped.
 */
async function checkCheckoutLink(
  base: string,
  key: string,
  priceId: string,
  appOrigin: string | undefined,
): Promise<void> {
  const where = 'the default payment link';
  const created = await paddle<{ id: string; status?: string; checkout?: { url?: string | null } }>(
    base,
    key,
    'POST',
    '/transactions',
    {
      items: [{ price_id: priceId, quantity: 1 }],
      // Stamped so a human meeting this in the dashboard knows what made it. The
      // real checkout stamps `{ userId }` here instead; nothing reads this one.
      custom_data: { createdBy: 'check:paddle' },
    },
  );

  if (!created.data?.id) {
    fail(
      where,
      created.error?.code === 'transaction_default_checkout_url_not_set'
        ? 'not set on this Paddle account. Every checkout 502s until it is — set it to ' +
            `${appOrigin ?? '<app origin>'}/settings/subscription (Checkout settings).`
        : `POST /transactions answered ${created.status}` +
            `${created.error?.detail ? `: ${created.error.detail}` : ''}`,
    );
    return;
  }

  const transactionId = created.data.id;
  try {
    const url = created.data.checkout?.url;
    if (!url) {
      fail(where, `transaction ${transactionId} came back with no checkout.url`);
      return;
    }

    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/settings/subscription')) {
      fail(
        where,
        `points at ${parsed.origin}${parsed.pathname}. It must be the subscription settings ` +
          'page: the app root redirects to /links and DROPS the query, so the `_ptxn` in ' +
          'Paddle’s own dunning email would open the library instead of the checkout.',
      );
    } else if (appOrigin && parsed.origin !== appOrigin) {
      // One sandbox account serves development AND staging, so its link can only
      // ever match one of them — a mismatch there is information, not a failure.
      // On production it is the real thing pointing somewhere else.
      const line = `points at ${parsed.origin}, not this tier’s ${appOrigin}`;
      if (base.includes('sandbox'))
        notes.push(`${where}: ${line} (one sandbox account, two tiers)`);
      else fail(where, line);
    } else {
      notes.push(`${where}: ${parsed.origin}${parsed.pathname}`);
    }
  } finally {
    // Never leave it payable. A draft transaction costs nothing and expires on its
    // own, but a stray `ready` one is a live payment link sitting in the account.
    const canceled = await paddle(base, key, 'PATCH', `/transactions/${transactionId}`, {
      status: 'canceled',
    });
    if (canceled.status >= 300) {
      notes.push(
        `could not cancel ${transactionId} (Paddle ${canceled.status}) — unpaid, cancel it by hand`,
      );
    }
  }
}

// --- the run ---------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tier = (argv.find((a) => !a.startsWith('-')) ?? 'development') as Tier;
  const yes = argv.includes('--yes');
  const skipCheckout = argv.includes('--no-checkout');

  if (!TIERS.includes(tier)) {
    console.error(`unknown tier "${tier}" — one of: ${TIERS.join(', ')}`);
    process.exit(1);
  }

  const base = workerVar(tier, 'PADDLE_API_BASE');
  if (!base) {
    console.error(`no PADDLE_API_BASE in wrangler.jsonc’s "${tier}" env`);
    process.exit(1);
  }
  const appOrigin = webEnv(tier, 'NEXT_PUBLIC_APP_URL');
  const { key, from } = resolveApiKey(tier);

  console.log(`tier:  ${tier}`);
  console.log(`paddle: ${base}`);
  console.log(`key:    ${from}`);

  // The live account is a real business record. Minting even an unpaid transaction
  // there should be a thing you meant to do — same posture as the deploy scripts'
  // production prompt.
  if (tier === 'production' && !skipCheckout && !yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(
      'This creates and cancels one unpaid transaction in the LIVE account. Continue? [y/N] ',
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('aborted.');
      process.exit(1);
    }
  }

  try {
    let onSaleId: string | undefined;

    for (const plan of PAID_PLANS) {
      const configured = priceIds(
        workerVar(tier, plan === 'pro' ? 'PADDLE_PRICE_ID_PRO' : 'PADDLE_PRICE_ID_PLUS'),
      );

      // The catalog/storefront split (@stxapps/shared iap/plans.ts): a plan that is
      // not on sale has no checkout to protect, and its placeholder config is not a
      // failure. Putting it on sale is what brings it in here.
      if (!(AVAILABLE_PAID_PLANS as readonly string[]).includes(plan)) {
        notes.push(`${plan}: not on sale — ${configured.length} id(s) configured, not checked`);
        continue;
      }

      if (configured.length === 0) {
        fail(
          `${plan}`,
          `PADDLE_PRICE_ID_${plan.toUpperCase()} is empty in the "${tier}" env — ` +
            'the checkout 500s with `not_configured`',
        );
        continue;
      }

      for (const [index, id] of configured.entries()) {
        await checkPrice(base, key, plan, id, index === 0);
      }
      onSaleId ??= configured[0];
    }

    // One id in two plans' lists makes the price → plan lookup ambiguous, and it
    // resolves to Pro in silence (planOfPaddlePrices checks Pro first, by design).
    const all = PAID_PLANS.flatMap((plan) =>
      priceIds(workerVar(tier, plan === 'pro' ? 'PADDLE_PRICE_ID_PRO' : 'PADDLE_PRICE_ID_PLUS')),
    );
    const duplicated = all.filter((id, i) => all.indexOf(id) !== i);
    for (const id of new Set(duplicated)) {
      fail(id, 'is configured for more than one plan — the price → plan lookup silently picks Pro');
    }

    if (skipCheckout) {
      notes.push('the default payment link: not checked (--no-checkout)');
    } else if (onSaleId) {
      await checkCheckoutLink(base, key, onSaleId, appOrigin);
    }
  } catch (e) {
    if (e instanceof PaddleError) {
      console.error(`\ncould not run the check — ${e.message}`);
      console.error('This says nothing about the catalog. Fix the reach, then re-run.');
      process.exit(2);
    }
    throw e;
  }

  for (const note of notes) console.log(`  ${note}`);

  if (failures.length === 0) {
    console.log(`\nok — the ${tier} Paddle catalog still matches what this repo sells.`);
    return;
  }

  console.error(`\nBLOCKED: ${failures.length} thing(s) wrong with the ${tier} Paddle config.\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error('Every one of these is dashboard state, and none of them fails anywhere else');
  console.error('until a customer tries to pay. docs/iap.md, _config per env_, has the contract.');
  process.exit(1);
}

main();
