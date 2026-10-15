'use client';

// Direct blob transfer to/from Cloudflare R2 over a presigned URL — the ONE data
// path that bypasses the API (docs/local-first-sync.md: "the blob bytes never
// touch the API"). The URL is a short-lived SigV4 presign minted by
// `files/sign`; the bytes are already AES-GCM encrypted (@stxapps/web-crypto blob.ts), so R2
// only ever sees ciphertext. No auth header here — the signature in the URL is
// the credential.

import {
  BLOB_BASE_TIMEOUT_MS,
  BLOB_IDLE_TIMEOUT_MS,
  blobTransferTimeoutMs,
  withDeadline,
} from '@stxapps/shared';

// Carries the HTTP status so callers can branch on it — the one the sync engine
// cares about is a GET 404 (the object was deleted between the op pull / listing
// and the fetch), which it skips rather than failing the whole cycle.
export class BlobRequestError extends Error {
  constructor(
    readonly method: 'PUT' | 'GET',
    readonly status: number,
  ) {
    super(`R2 ${method} failed (${status})`);
    this.name = 'BlobRequestError';
  }
}

// A transfer that outlived its deadline (`blobTransferTimeoutMs`, @stxapps/shared
// sync/blob-transfer.ts). No status — R2 never answered — so its own class rather
// than a BlobRequestError the engine could mistake for a 404.
export class BlobTimeoutError extends Error {
  constructor(
    readonly method: 'PUT' | 'GET',
    readonly timeoutMs: number,
  ) {
    super(`R2 ${method} timed out after ${timeoutMs} ms`);
    this.name = 'BlobTimeoutError';
  }
}

// The whole body is known up front, so the deadline is sized once. A browser
// resolves a PUT's fetch only once the upload has gone and R2 has answered.
export async function putBlob(url: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  await withDeadline(
    async (signal) => {
      const res = await fetch(url, { method: 'PUT', body, signal });
      if (!res.ok) throw new BlobRequestError('PUT', res.status);
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
export async function getBlob(url: string): Promise<Uint8Array> {
  return withDeadline(
    async (signal, rearm) => {
      const res = await fetch(url, { method: 'GET', signal });
      if (!res.ok) throw new BlobRequestError('GET', res.status);
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
