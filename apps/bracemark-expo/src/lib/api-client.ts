import { createAuthApiClient } from '@stxapps/expo-react/lib/auth-api-client';

// bracemark-expo's binding of the shared auth-aware API client to bracemark-api's base
// URL — the RN counterpart of bracemark-web's `lib/api-client.ts` and the extension's
// `utils/api-client.ts`. The auth-fetch logic (bearer token + mid-session
// 401/expiry handling) lives in expo-react's createAuthApiClient; only the base
// URL is app-specific, and it comes from `EXPO_PUBLIC_API_URL` — Metro inlines
// `EXPO_PUBLIC_*` vars at build time from `.env.<mode>`, the Expo analogue of
// Next's `NEXT_PUBLIC_API_URL` / wxt's `WXT_PUBLIC_API_URL`.
//
// One client serves both the app React tree (via ApiClientProvider in the root
// `_layout`) and the sync engine (which builds `SyncDeps.api` from it). Both read
// the same in-memory session mirror: the app's AuthProvider hydrates it on mount;
// a background/share-extension context hydrates it with loadSession() first.
const baseUrl = process.env.EXPO_PUBLIC_API_URL;
if (!baseUrl) throw new Error('EXPO_PUBLIC_API_URL is not set');

export const apiClient = createAuthApiClient({ baseUrl });
