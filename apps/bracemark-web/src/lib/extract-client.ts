import { createExtractClient, type ExtractClient } from '@stxapps/shared';

// App-level binding of the `bracemark-extractor` client to its OWN origin —
// `extractor.bracemark.com`, set per environment via `NEXT_PUBLIC_EXTRACTOR_URL`. This is a
// DIFFERENT origin from bracemark-api's `NEXT_PUBLIC_API_URL` (lib/api-client.ts) on purpose:
// the extractor is the one component that fetches arbitrary user URLs, kept apart
// from the sync broker so "api.bracemark.com never sees your library in plaintext"
// stays code-provable (docs/link-extraction-server.md). Spelled that way
// deliberately: the api is one Worker that also serves auth and billing, so "only ever
// sees ciphertext" is false of it — the library is the part that is ciphertext-only.
// It's anonymous — no
// auth client — so this is the plain shared `createExtractClient`, not
// `createAuthApiClient`.
//
// Unlike lib/api-client.ts, a MISSING env var is NOT fatal: server extraction is an opt-in
// feature off by default, so an environment that doesn't configure an extractor just
// leaves the client null and the ExtractionProvider loop inert — the app still runs.
const baseUrl = process.env.NEXT_PUBLIC_EXTRACTOR_URL;

export const extractClient: ExtractClient | null = baseUrl
  ? createExtractClient({ baseUrl })
  : null;
