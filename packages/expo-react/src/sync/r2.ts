// Blob transfer over a URL `files/sign` minted — the expo sibling of web-react's
// sync/r2.ts (see there for the two kinds of URL: a presign of R2, whose
// signature is the credential, or the api's blob route, whose token rides in the
// `authorization` passed here; the bytes are already AES-GCM ciphertext either
// way). Every transfer below takes that `authorization` and sends it as the
// header when there is one.
//
// Two transports, split by payload size (the same split as the crypto boundary,
// sync/crypto.ts): small ENTITY blobs ride Expo's native fetch as in-memory
// Uint8Arrays; `files/` CONTENT moves path-to-path in the native layer —
// download via the new-API `File.downloadFileAsync`, upload via the legacy
// `uploadAsync` (the new API has no upload yet; `expo/fetch` would buffer the
// whole file into the JS heap, which is exactly what the file pipeline exists
// to avoid).
//
// ⚠ Do not replace `expoFetch` with React Native's global fetch. On Android,
// RN 0.81 accepts `Uint8Array`/`ArrayBuffer` in its BodyInit type but rejects
// either at runtime with "Network request failed" before sending a request.
// The JSON API client is unaffected; this is the only in-memory binary PUT.

import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';

import {
  BlobNetworkError,
  BlobRequestError,
  BlobTimeoutError,
  blobTransferTimeoutMs,
  parseRetryAfterSeconds,
  receiptOf,
  retryAfterSecondsOf,
  withDeadline,
} from '@stxapps/shared';

// What a transfer throws is shared with web's sibling (@stxapps/shared
// sync/blob-transfer.ts), so the retry layers read one set of classes.
export { BlobNetworkError, BlobRequestError, BlobTimeoutError };

// A DROPPED CONNECTION IS TYPED HERE, because nowhere else can tell one. Each
// transport fails its own way, and none of them says "network": `expo/fetch`
// rejects with a FetchError it does not export (named plain `Error`, its message
// prefixed `fetch failed:`), React Native's fetch with a TypeError, and the
// legacy `uploadAsync` with a bare Error carrying the native message. Above this
// file a dropped connection and a missing temp file look the same, so the
// engine could not retry one without retrying the other — and it retried
// neither (docs/local-first-sync.md, _retrying a failure_, expo's network
// errors). Here the kind is known by WHICH CALL threw:
//
//   - the fetch call itself — not the status check after it — failed before the
//     host answered. Our only abort is the deadline, which rejects first as a
//     BlobTimeoutError, so what is left is the request failing on the wire.
//   - an upload whose file still exists failed in flight. One whose file is
//     gone failed locally, and a retry would fail the same way, so that error
//     goes up as it is.
function asNetworkError(method: 'PUT' | 'GET', err: unknown): unknown {
  return err instanceof BlobNetworkError ? err : new BlobNetworkError(method, err);
}

// The two JS-fetch transfers carry a deadline (`blobTransferTimeoutMs`,
// @stxapps/shared sync/blob-transfer.ts); neither transport has one of its own —
// React Native's OkHttp client sets every timeout to 0 (none) on Android, and
// `expo/fetch` sets the request's `timeoutInterval` to 0 on iOS. The two native
// file transfers below don't need one: their own URLSession/OkHttp idle timeouts
// fail a stalled connection.
function headersFor(authorization: string | undefined): Record<string, string> | undefined {
  return authorization ? { authorization } : undefined;
}

// Both PUTs resolve with the upload receipt the blob route answered with, or
// undefined when there was none — see web-react's sync/r2.ts putBlob.
export async function putBlob(
  url: string,
  body: Uint8Array<ArrayBuffer>,
  authorization?: string,
): Promise<string | undefined> {
  return withDeadline(
    async (signal) => {
      const res = await expoFetch(url, {
        method: 'PUT',
        body,
        headers: headersFor(authorization),
        signal,
      }).catch((err: unknown) => {
        throw asNetworkError('PUT', err);
      });
      if (!res.ok) throw new BlobRequestError('PUT', res.status, parseRetryAfterSeconds(res));
      return receiptOf(await res.text().catch(() => ''));
    },
    blobTransferTimeoutMs(body.byteLength),
    (ms) => new BlobTimeoutError('PUT', ms),
  );
}

// Entity blobs only (a few KB) — `files/` content downloads through
// getBlobToFile. A total deadline, not web's idle one: React Native's fetch
// resolves only after the whole body has arrived, so there is no progress to
// restart the clock on, and the base allowance covers an entity body anyway.
export async function getBlob(url: string, authorization?: string): Promise<Uint8Array> {
  return withDeadline(
    async (signal) => {
      const res = await fetch(url, {
        method: 'GET',
        headers: headersFor(authorization),
        signal,
      }).catch((err: unknown) => {
        throw asNetworkError('GET', err);
      });
      if (!res.ok) throw new BlobRequestError('GET', res.status, parseRetryAfterSeconds(res));
      // The body arrives after the headers, and a connection can drop between.
      const body = await res.arrayBuffer().catch((err: unknown) => {
        throw err instanceof TypeError ? asNetworkError('GET', err) : err;
      });
      return new Uint8Array(body);
    },
    blobTransferTimeoutMs(0),
    (ms) => new BlobTimeoutError('GET', ms),
  );
}

// PUT a whole file's bytes from disk — native streaming upload
// (BINARY_CONTENT: the file IS the request body, same shape putBlob sends), so
// a MB-sized ciphertext never enters the JS heap. Unlike fetch, uploadAsync
// resolves on any HTTP status, so the ok-check is ours.
export async function putBlobFromFile(
  url: string,
  file: File,
  authorization?: string,
): Promise<string | undefined> {
  const res = await uploadAsync(url, file.uri, {
    httpMethod: 'PUT',
    uploadType: FileSystemUploadType.BINARY_CONTENT,
    headers: headersFor(authorization),
  }).catch((err: unknown) => {
    throw file.exists ? asNetworkError('PUT', err) : err;
  });
  if (res.status < 200 || res.status >= 300) {
    throw new BlobRequestError('PUT', res.status, retryAfterSecondsOf(headerOf(res.headers)));
  }
  return receiptOf(res.body ?? '');
}

// `Retry-After` from the native upload's headers, which come back as a plain
// record whose key case is the platform's.
function headerOf(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'retry-after') return value;
  }
  return undefined;
}

// Both native implementations reject a non-2xx download with only a MESSAGE —
// "response has status \(code)" on iOS, "response has status: ${code}" on
// Android — so this is the one place that string is parsed back into a typed
// status. Brittle by nature; if an expo-file-system upgrade rewords it, the
// 404-skip in the engine degrades to a thrown cycle error (safe, just noisier).
const DOWNLOAD_STATUS_RE = /response has status:? (\d{3})/;

// GET a blob straight to `file` on disk (overwriting a previous temp), never
// through the JS heap — the download half of the `files/` content pipeline.
export async function getBlobToFile(
  url: string,
  file: File,
  authorization?: string,
): Promise<void> {
  try {
    await File.downloadFileAsync(url, file, {
      idempotent: true,
      headers: headersFor(authorization),
    });
  } catch (err: unknown) {
    const match = err instanceof Error ? DOWNLOAD_STATUS_RE.exec(err.message) : null;
    if (match) throw new BlobRequestError('GET', Number(match[1]));
    throw err;
  }
}
