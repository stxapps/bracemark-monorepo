'use client';

import { createContext, type ReactNode, useContext } from 'react';

import type { ApiClient } from '@stxapps/shared';

// Lets the framework-agnostic query/mutation hooks in this package reach a
// configured ApiClient without importing any app's baseUrl. Each app builds its
// own client (createApiClient with its env baseUrl) and provides it here, so the
// same hooks work in bracemark-web, bracemark-extension, and future bracemark-expo.

const ApiClientContext = createContext<ApiClient | null>(null);

export function ApiClientProvider({
  client,
  children,
}: {
  client: ApiClient;
  children: ReactNode;
}) {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (!client) {
    throw new Error('useApiClient must be used within an <ApiClientProvider>');
  }
  return client;
}
