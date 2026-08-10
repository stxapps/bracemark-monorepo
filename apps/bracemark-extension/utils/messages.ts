import type { ExtractionFacet } from '@stxapps/web-react';

// The typed popup → background message protocol (replaces the starter's single
// `SAVE_PAGE`). The background owns ALL privileged / CORS-exempt work — the sync
// cycle and every capture — so the popup never fetches bracemark-api or touches a tab
// directly; it sends one of these and renders the result.
//
// Reading sync status is NOT a message: it's the browser.storage.local mirror in
// mirrored-sync-state.ts (read directly / via storage.onChanged), so it never wakes the
// worker just to read state the caller can read itself.
export type ExtensionMessage =
  | { type: 'KICK_SYNC' } // run a sync cycle now (e.g. right after a local edit)
  | { type: 'EXTRACT'; linkId: string; facet: ExtractionFacet }; // capture one facet of one link

// What each message resolves to — a `{ ok }` envelope for the imperative commands.
export interface MessageResponses {
  KICK_SYNC: { ok: boolean; error?: string };
  EXTRACT: { ok: boolean; error?: string };
}

// Typed wrapper over browser.runtime.sendMessage so call sites get the right
// response type for the message they send.
export function sendMessage<T extends ExtensionMessage>(
  message: T,
): Promise<MessageResponses[T['type']]> {
  return browser.runtime.sendMessage(message) as Promise<MessageResponses[T['type']]>;
}
