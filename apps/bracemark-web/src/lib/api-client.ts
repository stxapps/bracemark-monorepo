import { createAuthApiClient } from '@stxapps/web-react';

// App-level binding of the shared auth-aware API client to bracemark-api's base URL.
// Set NEXT_PUBLIC_API_URL per environment. The auth-fetch logic (bearer token +
// mid-session 401/expiry handling) lives in web-react's createAuthApiClient,
// shared with bracemark-extension; only the env-resolved base URL is app-specific.
// Call sites use the shared endpoint contracts: `apiClient.call(checkUsernameEndpoint, …)`.
const baseUrl = process.env.NEXT_PUBLIC_API_URL;
if (!baseUrl) throw new Error('NEXT_PUBLIC_API_URL is not set');

export const apiClient = createAuthApiClient({ baseUrl });
