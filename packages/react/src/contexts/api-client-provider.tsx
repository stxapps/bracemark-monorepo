'use client';

import { createContext, type ReactNode, useContext } from 'react';

import type { AuthApiClient } from '@stxapps/shared';

// Lets the framework-agnostic query/mutation hooks in this package reach a
// configured ApiClient without importing any app's baseUrl. Each app builds its
// own client (its platform's createAuthApiClient with its env baseUrl) and
// provides it here, so the same hooks work in bracemark-web, bracemark-extension
// (the browser extension) and bracemark-expo. An AuthApiClient, so a sync cycle
// can bind its requests to the session record it took its key from.

const ApiClientContext = createContext<AuthApiClient | null>(null);

export function ApiClientProvider({
  client,
  children,
}: {
  client: AuthApiClient;
  children: ReactNode;
}) {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): AuthApiClient {
  const client = useContext(ApiClientContext);
  if (!client) {
    throw new Error('useApiClient must be used within an <ApiClientProvider>');
  }
  return client;
}
