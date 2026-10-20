'use client';

// Blob transfer over a URL `files/sign` minted — the data path, kept apart from
// the api client's JSON calls (docs/local-first-sync.md, _the blob route_). The
// URL is one of two kinds, and these helpers don't care which:
//
//   - a SigV4 presign of R2's S3 endpoint, whose signature is the credential, or
//   - the api's blob route, with an `authorization` value to send as the header —
//     a token for this one object and method, not the session's bearer.
//
// `authorization` is passed through when `files/sign` returned one and omitted
// when it didn't; that is the whole of the difference. The bytes are already
// AES-GCM encrypted (@stxapps/web-crypto blob.ts), so either host only ever sees
// ciphertext.

import {
  BLOB_BASE_TIMEOUT_MS,
  BLOB_IDLE_TIMEOUT_MS,
  BlobRequestError,
  BlobTimeoutError,
  blobTransferTimeoutMs,
  parseRetryAfterSeconds,
  receiptOf,
  withDeadline,
} from '@stxapps/shared';

// What a transfer throws is shared with expo's sibling (@stxapps/shared
// sync/blob-transfer.ts), so the retry layers read one set of classes. A browser's
// fetch reports a dropped connection as a TypeError, and these let it through as
// one: the engine reads it as a network error (sync/engine.ts).
export { BlobRequestError, BlobTimeoutError };

function headersFor(authorization: string | undefined): HeadersInit | undefined {
  return authorization ? { authorization } : undefined;
}

// The whole body is known up front, so the deadline is sized once. A browser
// resolves a PUT's fetch only once the upload has gone and the host has answered.
//
// Resolves with the upload receipt the blob route answered with, for the commit
// to carry back (@stxapps/shared receiptOf, docs/local-first-sync.md _upload
// receipts_), or undefined: a presigned PUT answers with nothing, nor does an
// api that predates receipts. The bytes landed either way — the status said so —
// so a body that cannot be read only costs the commit a look at R2, and never
// fails the upload.
export async function putBlob(
  url: string,
  body: Uint8Array<ArrayBuffer>,
  authorization?: string,
): Promise<string | undefined> {
  return withDeadline(
    async (signal) => {
      const res = await fetch(url, {
        method: 'PUT',
        body,
        headers: headersFor(authorization),
        signal,
      });
      if (!res.ok) throw new BlobRequestError('PUT', res.status, parseRetryAfterSeconds(res));
      return receiptOf(await res.text().catch(() => ''));
    },
    blobTransferTimeoutMs(body.byteLength),
    (ms) => new BlobTimeoutError('PUT', ms),
  );
}

// An IDLE deadline, not a total one (@stxapps/shared sync/blob-transfer.ts): R2
// gets the base allowance to answer, then the clock restarts on every chunk of
// the body. A `files/` GET (loadEntityContent) can be megabytes, and a total
// deadline sized from Content-Length would fail it on every cycle on a link
// slower than the floor; this one fails only a body that stops arriving. The
// timeout's `timeoutMs` is therefore the length of the silence, not of the
// transfer.
//
// A blob-route read is a POST whose whole body is the `authorization` value,
// sent as `text/plain` with no header of its own (the api's routes/blob.ts).
// Every blob-route read has the SAME URL, and both shapes of GET measured badly
// for that in Chrome: with `Authorization` it is preflighted, and with
// `cache: 'no-store'` — needed so the cache doesn't hold each read of the one URL
// behind the last, which ran a pull on two sockets of six — the preflight cache
// is skipped, so every read paid one (673 for 673). A text body makes the POST a
// CORS "simple" request, never preflighted, and no HTTP cache stores a POST. A
// presigned read has no token and a URL of its own, and is a plain GET as it
// always was.
export async function getBlob(url: string, authorization?: string): Promise<Uint8Array> {
  return withDeadline(
    async (signal, rearm) => {
      const res = await fetch(
        url,
        authorization ? { method: 'POST', body: authorization, signal } : { method: 'GET', signal },
      );
      if (!res.ok) throw new BlobRequestError('GET', res.status, parseRetryAfterSeconds(res));
      return readBody(res, () => rearm(BLOB_IDLE_TIMEOUT_MS));
    },
    BLOB_BASE_TIMEOUT_MS,
    (ms) => new BlobTimeoutError('GET', ms),
  );
}

// The body, gathered chunk by chunk so every chunk can report progress. Once for
// the headers, then once per chunk. A response with no stream to read (a null
// body) is read whole, under the idle deadline the headers started.
async function readBody(res: Response, onProgress: () => void): Promise<Uint8Array> {
  onProgress();
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    onProgress();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
