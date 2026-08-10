'use client';

import { createContext, type ReactNode, useContext } from 'react';

import type { ExtractClient } from '@stxapps/shared';

// The `bracemark-extractor` sibling of ApiClientProvider: a client-side seam so the
// function-bearing extract client never crosses the server→client boundary as a
// prop (functions aren't serializable — passing one from a Server Component
// prerenders into "Functions cannot be passed directly to Client Components").
// Each app builds its own env-bound client (createExtractClient with its
// NEXT_PUBLIC_EXTRACTOR_URL) and provides it here inside a Client Component, so the
// loop in web-react's ExtractionProvider reads it via the hook.
//
// Unlike useApiClient, null is a LEGITIMATE value, not a mounting bug: server
// extraction is opt-in/off-by-default, so an environment with no extractor origin
// leaves the client null and the loop inert. The hook returns null rather than
// throwing.

const ExtractClientContext = createContext<ExtractClient | null>(null);

export function ExtractClientProvider({
  client,
  children,
}: {
  client: ExtractClient | null;
  children: ReactNode;
}) {
  return <ExtractClientContext.Provider value={client}>{children}</ExtractClientContext.Provider>;
}

export function useExtractClient(): ExtractClient | null {
  return useContext(ExtractClientContext);
}
