// Replays App Store SANDBOX Server Notifications into the local bracemark-api,
// then shows what each one did to the local `purchases` rows.
//
//   npm run replay:appstore                           # the last 24 hours
//   npm run replay:appstore -- --since 3d             # 30m, 6h, 3d, or an ISO date
//   npm run replay:appstore -- --transaction 2000000123456789
//   npm run replay:appstore -- --type DID_RENEW
//   npm run replay:appstore -- --dry-run              # list them, POST nothing
//
// WHY THIS EXISTS. App Store Connect takes ONE sandbox notification URL per app,
// and it points at staging (docs/iap.md, _config per env_). Paddle can add a
// second destination for a tunnel; Apple can't. Apple does keep what it sent: the
// App Store Server API's notification history returns the signed payloads for
// the last 180 days. So local testing pulls them instead of receiving them, and
// needs no tunnel, no forwarder and no dashboard edit to undo afterwards.
//
// WHAT A REPLAY PROVES, AND WHAT IT DOESN'T. `appstore/notify` uses the payload
// only to find WHICH subscription changed, then re-fetches that subscription's
// state from Apple (the call-back pattern — lib/appstore.ts). So replaying an old
// DID_RENEW applies the subscription's state as of NOW, not as of that renewal.
// What this exercises is the push path end to end: route → payload decode →
// Apple fetch → binding lookup → upsert. It is not a time machine.
//
// And a notification only lands on a subscription THIS api bound through
// `iap/verify`. A purchase made from a build pointed at staging has no row here,
// and "no local row" below is that drop working as designed, not a bug.
//
// Development only, on purpose: the sandbox host, the development keychain item,
// and local D1 under apps/bracemark-api/.wrangler/ — the same three things
// `npm run dev` uses (tools/scripts/run-api-dev.sh).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8 } from '@stxapps/shared';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_DIR = path.join(REPO_ROOT, 'apps/bracemark-api');
const SANDBOX_API_BASE = 'https://api.storekit-sandbox.itunes.apple.com';
const NOTIFY_PATH = '/v1/iap/appstore/notify';
// Apple refuses a history query that starts further back than this.
const HISTORY_MAX_DAYS = 180;

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// --- the inputs ------------------------------------------------------------

/**
 * One `"NAME": "value"` pair out of the `development` env block of bracemark-api's
 * wrangler.jsonc — the same scoped read check-paddle.ts makes, and for the same
 * reason: every tier declares these names, so a file-wide match is right by luck.
 */
function workerVar(name: string): string | undefined {
  const source = read('apps/bracemark-api/wrangler.jsonc');
  const start = source.indexOf('\n    "development": {');
  if (start === -1) throw new Error('no "development" env block in wrangler.jsonc');
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\n    "', 1);
  const block = end === -1 ? rest : rest.slice(0, end);
  const match = block.match(new RegExp(`"${name}":\\s*"([^"]*)"`));
  return match ? match[1] : undefined;
}

/** An identifier the local api reads too — a TODO fails both, so say so here. */
function requireVar(name: string): string {
  const value = workerVar(name);
  if (!value || value.startsWith('TODO')) {
    throw new Error(
      `${name} is not set in wrangler.jsonc’s "development" env. It is an identifier, ` +
        'not a secret — commit it there. The local api needs it too, or every ' +
        'notification it re-fetches fails the same way.',
    );
  }
  return value;
}

/**
 * The In-App Purchase key's PKCS#8 PEM: the shell first, then the login keychain
 * item `wrangler dev` gets the same key from (tools/scripts/run-api-dev.sh). Never a
 * file in this worktree: the key is the same one production signs with, and it
 * works against the live Server API too (docs/env-files.md, _bracemark-api
 * local secrets_). Stored flattened to one line; `serverApiJwt` strips the
 * armour, all whitespace and escaped line breaks, so any of the shapes imports.
 */
function resolvePrivateKey(): { pem: string; from: string } {
  const fromShell = process.env.APPSTORE_PRIVATE_KEY;
  if (fromShell) return { pem: fromShell, from: 'the shell (APPSTORE_PRIVATE_KEY)' };

  const service = 'bracemark-appstore-key-development';
  try {
    const pem = execFileSync(
      'security',
      ['find-generic-password', '-a', 'bracemark', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (pem.includes('-----BEGIN')) return { pem, from: `the keychain (${service})` };
  } catch {
    // No keychain, or no such item — the error below says where the key goes.
  }
  throw new Error(
    `no APPSTORE_PRIVATE_KEY in the shell or the keychain item ${service}.\n` +
      'Add the In-App Purchase key, flattened to one line:\n' +
      `  security add-generic-password -U -a bracemark -s ${service} -w "$(tr -d '\\n' < AuthKey_<KEY_ID>.p8)"\n` +
      'See docs/env-files.md, _bracemark-api local secrets_.',
  );
}

// --- the App Store Server API ---------------------------------------------

/**
 * The Server API's ES256 JWT. The same claims as `appstoreApiJwt` in
 * bracemark-api lib/appstore.ts; duplicated rather than imported because that
 * module is a Worker's, typed against `Bindings`, and a tools script must not
 * reach into an app's graph (check-paddle.ts, `priceIds`, same call).
 */
async function serverApiJwt(issuerId: string, keyId: string, bundleId: string, pem: string) {
  const encode = (value: unknown) =>
    bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const iat = Math.floor(Date.now() / 1000);
  const signingInput =
    `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.` +
    encode({ iss: issuerId, iat, exp: iat + 5 * 60, aud: 'appstoreconnect-v1', bid: bundleId });

  const der = Buffer.from(
    // `\\[nr]`: escaped line breaks, as lib/jwt.ts pemToPkcs8 drops them. Node's
    // base64 decoder skips the backslash but KEEPS the `n`, so without this an
    // escaped PEM decodes to garbage DER rather than failing to decode.
    pem.replace(/-----(BEGIN|END)[A-Z ]*KEY-----/g, '').replace(/\\[nr]|\s+/g, ''),
    'base64',
  );
  const key = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

type HistoryItem = { signedPayload: string };

async function fetchHistory(
  jwt: string,
  filter: { startDate: number; endDate: number; transactionId?: string; notificationType?: string },
): Promise<HistoryItem[]> {
  const items: HistoryItem[] = [];
  let paginationToken: string | undefined;
  do {
    const query = paginationToken ? `?paginationToken=${encodeURIComponent(paginationToken)}` : '';
    const res = await fetch(`${SANDBOX_API_BASE}/inApps/v1/notifications/history${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(filter),
    });
    if (res.status === 401) {
      throw new Error(
        'Apple 401 — the key id, issuer id, bundle id and private key do not belong together.',
      );
    }
    const json = (await res.json().catch(() => ({}))) as {
      notificationHistory?: HistoryItem[];
      hasMore?: boolean;
      paginationToken?: string;
      errorCode?: number;
      errorMessage?: string;
    };
    if (!res.ok) {
      throw new Error(
        `Apple ${res.status} on notification history` +
          `${json.errorMessage ? `: ${json.errorMessage} (${json.errorCode})` : ''}`,
      );
    }
    items.push(...(json.notificationHistory ?? []));
    paginationToken = json.hasMore ? json.paginationToken : undefined;
  } while (paginationToken);
  return items;
}

/** A JWS payload, unverified — this is display only; the api re-fetches the facts. */
function decodeJws(jws: string | undefined): Record<string, unknown> {
  const part = jws?.split('.')[1];
  if (!part) return {};
  try {
    return JSON.parse(bytesToUtf8(base64UrlToBytes(part))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

type Notification = {
  signedPayload: string;
  type: string;
  signedDate: number;
  originalTransactionId: string | null;
  productId: string | null;
};

function describe(item: HistoryItem): Notification {
  const payload = decodeJws(item.signedPayload);
  const data = (payload.data ?? {}) as { signedTransactionInfo?: string };
  const info = decodeJws(data.signedTransactionInfo);
  const subtype = typeof payload.subtype === 'string' ? `/${payload.subtype}` : '';
  return {
    signedPayload: item.signedPayload,
    type: `${String(payload.notificationType ?? '?')}${subtype}`,
    signedDate: typeof payload.signedDate === 'number' ? payload.signedDate : 0,
    originalTransactionId:
      typeof info.originalTransactionId === 'string' ? info.originalTransactionId : null,
    productId: typeof info.productId === 'string' ? info.productId : null,
  };
}

// --- local D1 ---------------------------------------------------------------

type PurchaseRow = {
  external_id: string;
  user_id: string;
  plan: string;
  status: string;
  expires_at: number | null;
  canceled_at: number | null;
  updated_at: number;
};

/**
 * The local `purchases` rows for these subscriptions, via the wrangler CLI against
 * miniflare's SQLite — the same `d1 execute --local` e2e/seed/plan.ts drives.
 * Ids are Apple's digits, but they came off an unverified payload, so they are
 * filtered to that shape before they go anywhere near SQL.
 */
function localPurchases(externalIds: string[]): Map<string, PurchaseRow> {
  const ids = externalIds.filter((id) => /^[0-9]+$/.test(id));
  if (ids.length === 0) return new Map();
  const sql =
    'SELECT external_id, user_id, plan, status, expires_at, canceled_at, updated_at ' +
    `FROM purchases WHERE source = 'appstore' AND external_id IN (${ids.map((id) => `'${id}'`).join(', ')})`;
  const stdout = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'DIRECTORY_DB',
      '--env',
      'development',
      '--local',
      '--json',
      '--command',
      sql,
    ],
    {
      cwd: API_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`wrangler d1 execute returned no JSON:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start)) as { results?: PurchaseRow[] }[];
  return new Map((parsed[0]?.results ?? []).map((row) => [row.external_id, row]));
}

// --- the run ---------------------------------------------------------------

const time = (ms: number | null) =>
  ms === null ? 'never' : new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

const summarize = (row: PurchaseRow) =>
  `${row.status} ${row.plan}, expires ${time(row.expires_at)}` +
  `${row.canceled_at !== null ? ', not renewing' : ''}`;

/** `30m`, `6h`, `3d`, or anything Date parses. */
function parseSince(value: string): number {
  const relative = value.match(/^(\d+)([mhd])$/);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'm' | 'h' | 'd'];
    return Date.now() - Number(relative[1]) * unit;
  }
  const absolute = Date.parse(value);
  if (Number.isNaN(absolute))
    throw new Error(`--since: cannot read "${value}" (try 6h, 3d, or a date)`);
  return absolute;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const api = (flag(argv, '--api') ?? 'http://localhost:8787').replace(/\/$/, '');
  const transactionId = flag(argv, '--transaction');
  const notificationType = flag(argv, '--type');
  const startDate = Math.max(
    parseSince(flag(argv, '--since') ?? '24h'),
    Date.now() - (HISTORY_MAX_DAYS - 1) * 86_400_000,
  );

  // Local only. The before/after below reads LOCAL D1, so against any other host
  // it would report on a database the POSTs never touched.
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(api)) {
    throw new Error(`--api must be a local origin (http://localhost:<port>), not ${api}`);
  }

  const { pem, from } = resolvePrivateKey();
  const jwt = await serverApiJwt(
    requireVar('APPSTORE_ISSUER_ID'),
    requireVar('APPSTORE_KEY_ID'),
    requireVar('APPSTORE_BUNDLE_ID'),
    pem,
  );

  console.log(`apple: ${SANDBOX_API_BASE} (key from ${from})`);
  console.log(`api:   ${api}${dryRun ? ' (dry run — nothing is sent)' : ''}`);
  console.log(`since: ${time(startDate)} UTC\n`);

  const history = await fetchHistory(jwt, {
    startDate,
    endDate: Date.now(),
    ...(transactionId ? { transactionId } : {}),
    ...(notificationType ? { notificationType } : {}),
  });
  // Oldest first — the order they happened in, and so the order they are sent in.
  const notifications = history.map(describe).sort((a, b) => a.signedDate - b.signedDate);

  if (notifications.length === 0) {
    console.log('Apple has no sandbox notifications in that window.');
    console.log('It only records what it tried to deliver, so the Sandbox Server URL must be');
    console.log('set in App Store Connect — then buy or renew in the sandbox and re-run.');
    return;
  }

  const subscriptions = [
    ...new Set(notifications.map((n) => n.originalTransactionId).filter((id) => id !== null)),
  ];
  const before = dryRun ? new Map<string, PurchaseRow>() : localPurchases(subscriptions);

  for (const n of notifications) {
    const line =
      `${time(n.signedDate)}  ${n.type.padEnd(28)}  ` +
      `${n.originalTransactionId ?? '(no transaction)'}  ${n.productId ?? ''}`;
    if (dryRun) {
      console.log(line);
      continue;
    }

    let status: string;
    try {
      const res = await fetch(`${api}${NOTIFY_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedPayload: n.signedPayload }),
      });
      // The route is log-and-ACK, so a 200 says it was handled, not that it
      // changed anything — the row comparison below is the answer to that. A
      // non-200 is the one real signal: Apple's API failed, and Apple would retry.
      status = res.ok ? `${res.status}` : `${res.status} ${await res.text()}`;
    } catch (e) {
      throw new Error(
        `could not reach ${api} (${(e as Error).message}). Is \`npm run dev\` running?`,
      );
    }
    console.log(`${line}  → ${status}`);
  }

  if (dryRun) return;

  const after = localPurchases(subscriptions);
  console.log('\nlocal purchases rows:');
  for (const id of subscriptions) {
    const was = before.get(id);
    const now = after.get(id);
    if (!now) {
      console.log(
        `  ${id}  no local row — never verified against THIS api, so the push is ` +
          'dropped by design (the wrangler dev log says "no binding yet").',
      );
    } else if (!was) {
      console.log(`  ${id}  created: ${summarize(now)}`);
    } else if (summarize(was) !== summarize(now)) {
      console.log(
        `  ${id}  changed: ${summarize(was)}\n  ${' '.repeat(id.length)}       → ${summarize(now)}`,
      );
    } else if (was.updated_at !== now.updated_at) {
      console.log(
        `  ${id}  rewritten, unchanged: ${summarize(now)} (Apple’s state already matched)`,
      );
    } else {
      console.log(
        `  ${id}  not written: ${summarize(now)} — check the wrangler dev log for ` +
          'applyStoreNotification',
      );
    }
  }
}

main().catch((e: unknown) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
