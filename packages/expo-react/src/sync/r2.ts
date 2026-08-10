// Direct blob transfer to/from Cloudflare R2 over a presigned URL — the expo
// sibling of web-react's sync/r2.ts (see there for the trust model: the ONE
// data path that bypasses the API; the SigV4 signature in the URL is the
// credential; the bytes are already AES-GCM ciphertext).
//
// Two transports, split by payload size (the same split as the crypto boundary,
// sync/crypto.ts): small ENTITY blobs ride `fetch` as in-memory Uint8Arrays
// (React Native's fetch takes typed-array bodies and hands back arrayBuffer());
// `files/` CONTENT moves path-to-path in the native layer — download via the
// new-API `File.downloadFileAsync`, upload via the legacy `uploadAsync` (the
// new API has no upload yet; `expo/fetch` would buffer the whole file into the
// JS heap, which is exactly what the file pipeline exists to avoid).

import { File } from 'expo-file-system';
import { FileSystemUploadType, uploadAsync } from 'expo-file-system/legacy';

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

// PUT a whole file's bytes from disk — native streaming upload
// (BINARY_CONTENT: the file IS the request body, same shape putBlob sends), so
// a MB-sized ciphertext never enters the JS heap. Unlike fetch, uploadAsync
// resolves on any HTTP status, so the ok-check is ours.
export async function putBlobFromFile(url: string, file: File): Promise<void> {
  const res = await uploadAsync(url, file.uri, {
    httpMethod: 'PUT',
    uploadType: FileSystemUploadType.BINARY_CONTENT,
  });
  if (res.status < 200 || res.status >= 300) throw new BlobRequestError('PUT', res.status);
}

// Both native implementations reject a non-2xx download with only a MESSAGE —
// "response has status \(code)" on iOS, "response has status: ${code}" on
// Android — so this is the one place that string is parsed back into a typed
// status. Brittle by nature; if an expo-file-system upgrade rewords it, the
// 404-skip in the engine degrades to a thrown cycle error (safe, just noisier).
const DOWNLOAD_STATUS_RE = /response has status:? (\d{3})/;

// GET a blob straight to `file` on disk (overwriting a previous temp), never
// through the JS heap — the download half of the `files/` content pipeline.
export async function getBlobToFile(url: string, file: File): Promise<void> {
  try {
    await File.downloadFileAsync(url, file, { idempotent: true });
  } catch (err: unknown) {
    const match = err instanceof Error ? DOWNLOAD_STATUS_RE.exec(err.message) : null;
    if (match) throw new BlobRequestError('GET', Number(match[1]));
    throw err;
  }
}
