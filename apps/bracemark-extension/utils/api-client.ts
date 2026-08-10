import { createAuthApiClient } from '@stxapps/web-react';

// The extension's binding of the shared auth-aware API client to bracemark-api's base
// URL — the counterpart of bracemark-web's `lib/api-client.ts`. The auth-fetch logic lives in
// web-react's createAuthApiClient (shared with bracemark-web); only the base URL is
// app-specific, and it comes from `WXT_PUBLIC_API_URL` (baked in per build mode
// from `.env.<mode>`, the wxt analogue of Next's `NEXT_PUBLIC_API_URL`).
// wxt.config.ts reads the SAME var to derive its `apiHost` host-permission, so the
// origin the client talks to is always one the manifest granted (and thus
// CORS-exempt for the background worker's fetches).
//
// One client serves both contexts — the popup React tree (via ApiClientProvider)
// AND the background service worker (which builds the sync `SyncDeps.api` from it).
// Both read the same in-memory session mirror: the popup's AuthProvider hydrates it
// on mount, the worker hydrates it with loadSession() before each cycle.
const baseUrl = import.meta.env.WXT_PUBLIC_API_URL;
if (!baseUrl) throw new Error('WXT_PUBLIC_API_URL is not set');

export const apiClient = createAuthApiClient({ baseUrl });
