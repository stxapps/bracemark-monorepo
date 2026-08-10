'use client';

// Direct blob transfer to/from Cloudflare R2 over a presigned URL — the ONE data
// path that bypasses the API (docs/local-first-sync.md: "the blob bytes never
// touch the API"). The URL is a short-lived SigV4 presign minted by
// `files/sign`; the bytes are already AES-GCM encrypted (see crypto.ts), so R2
// only ever sees ciphertext. No auth header here — the signature in the URL is
// the credential.

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

export async function putBlob(url: string, body: Uint8Array<ArrayBuffer>): Promise<void> {
  const res = await fetch(url, { method: 'PUT', body });
  if (!res.ok) throw new BlobRequestError('PUT', res.status);
}

export async function getBlob(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new BlobRequestError('GET', res.status);
  return new Uint8Array(await res.arrayBuffer());
}
