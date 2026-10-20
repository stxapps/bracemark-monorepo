// The upload receipt — what the blob route answers a PUT with (routes/blob.ts),
// and what the commit takes back in place of asking R2 whether the object
// landed (services/sync.ts commitOps). The route has R2's answer to the PUT in
// hand — the object's `LastModified` and size, the two facts a commit records
// for a put — and before receipts it threw them away, so the commit re-read
// them: a HEAD per put, or a listing walked page by page through the user's
// namespace. On a 10,000-link library a 500-edit commit spent 13.4 s doing that,
// one page after another, and the time grew with the LIBRARY, not the edit
// (docs/local-first-sync.md, _upload receipts_). A receipt makes the commit's
// side of a put an HMAC check.
//
// WHAT A RECEIPT PROVES, AND WHAT IT CANNOT. It proves the object landed at
// `LastModified` with `size` bytes, for this user and this path, under a token
// `files/sign` minted with the op log at `fence`. It cannot prove the object is
// still there at commit time, which is what the op-without-object invariant is
// about — so the commit asks the log about the gap instead (do/user-data.ts
// commitOps, THE FENCE): nothing removes an object but a committed delete or a
// wipe, and the log records both. A receipt the log cannot vouch for is not
// refused; its put is checked against R2 as if it had none.
//
// So a receipt is only ever a shortcut, never a requirement, and it is read the
// same way: a receipt that is malformed, expired, minted for another user or
// path, or under another key reads as no receipt at all (readUploadReceipt
// answers null) and the put is checked against R2. Forging one gains nothing a
// client could not get by PUTting the object, and the MAC means the size the
// quota map records is one R2 reported, never a number a client wrote. It is not
// bound to one PUT, though: a client that PUT the same path twice inside the TTL
// can commit either receipt, and the quota map then holds the earlier object's
// size. That opens nothing new — an object that is never committed is never
// counted at all, and the quota is a cost backstop, not a meter (lib/quota.ts).
//
// Format: `v1.<payload>.<mac>`, both base64url; the payload is JSON of five
// integers. The MAC covers the version and the payload as sent AND the user id
// and path, which are NOT in the payload: the commit already knows both (the
// session and the op), and leaving them out keeps the receipt's length bounded
// whatever the path's (@stxapps/shared MAX_RECEIPT_LENGTH says why that matters).
// The key is derived from R2_SECRET_ACCESS_KEY under its own label (hmac-key.ts),
// so a blob token never verifies as a receipt.

import { base64UrlToBytes, bytesToBase64Url, utf8 } from '@stxapps/shared';

import type { LogFence } from '../do/user-data';
import { derivedHmacKey } from './hmac-key';
import type { ObjectStat } from './user-files';

const VERSION = 'v1';
const HKDF_INFO = 'bracemark-api upload receipt v1';

// How long a receipt stands in for a look at R2. A client commits a chunk's
// receipts seconds after its uploads — behind at most one commit in flight and
// the contract client's retries — so an hour is far more than a commit needs,
// and a receipt that outlives it costs that one put an R2 check, nothing more.
// It also bounds what the fence has to cover: a delete the op log no longer
// holds can only be older than any receipt that is still good (do/user-data.ts).
export const RECEIPT_TTL_SECONDS = 60 * 60;

type Payload = {
  // R2's `LastModified` for the object, epoch ms — the op's stamp
  t: number;
  // R2's size for the object, bytes — its quota entry
  s: number;
  // the PUT token's log fence: generation, position (do/user-data.ts LogFence)
  g: number;
  q: number;
  // expiry, unix seconds
  e: number;
};

export type UploadReceipt = ObjectStat & { fence: LogFence };

function signedPart(payload: string, userId: string, path: string): Uint8Array<ArrayBuffer> {
  // JSON, so no user id or path can be read as another split of the same bytes.
  return utf8(JSON.stringify([VERSION, payload, userId, path]));
}

// `now` is injectable so tests are deterministic; defaults to the real clock.
export async function mintUploadReceipt(
  secret: string,
  receipt: { userId: string; path: string; stat: ObjectStat; fence: LogFence },
  now: number = Date.now(),
): Promise<string> {
  const { userId, path, stat, fence } = receipt;
  const body: Payload = {
    t: stat.updatedAt,
    s: stat.size,
    g: fence.generation,
    q: fence.position,
    e: Math.floor(now / 1000) + RECEIPT_TTL_SECONDS,
  };
  const payload = bytesToBase64Url(utf8(JSON.stringify(body)));
  const key = await derivedHmacKey(secret, HKDF_INFO);
  const mac = await crypto.subtle.sign('HMAC', key, signedPart(payload, userId, path));
  return `${VERSION}.${payload}.${bytesToBase64Url(new Uint8Array(mac))}`;
}

// What a receipt attests for `userId` and `path`, or null when it attests
// nothing the commit may rely on — and the put is then checked against R2.
export async function readUploadReceipt(
  secret: string,
  receipt: string,
  { userId, path }: { userId: string; path: string },
  now: number = Date.now(),
): Promise<UploadReceipt | null> {
  const [version, payload, mac, ...rest] = receipt.split('.');
  if (version !== VERSION || !payload || !mac || rest.length > 0) return null;

  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = base64UrlToBytes(mac);
  } catch {
    return null;
  }
  // subtle.verify compares in constant time; a string compare of two MACs would not.
  const key = await derivedHmacKey(secret, HKDF_INFO);
  if (!(await crypto.subtle.verify('HMAC', key, macBytes, signedPart(payload, userId, path)))) {
    return null;
  }

  let body: Partial<Payload>;
  try {
    body = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as Partial<Payload>;
  } catch {
    return null;
  }
  const { t, s, g, q, e } = body;
  if (![t, s, g, q, e].every((n) => Number.isSafeInteger(n) && (n as number) >= 0)) return null;
  if (Math.floor(now / 1000) >= (e as number)) return null;
  return {
    updatedAt: t as number,
    size: s as number,
    fence: { generation: g as number, position: q as number },
  };
}
