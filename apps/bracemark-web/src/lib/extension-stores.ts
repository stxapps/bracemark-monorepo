import { CHROME_WEB_STORE_URL, FIREFOX_ADDONS_URL } from '@stxapps/shared';

// The browser-extension listing to offer THIS browser. Only the two stores exist, so
// this is a Firefox test with Chrome as the fallback — which is also right for the
// Chromium family (Edge/Brave/Opera/Arc all install from the Chrome Web Store; there
// is no Edge Add-ons listing to send them to). A UA sniff is the honest tool here:
// what's being chosen is which STORE can install into this browser, which is a
// browser-identity question, not a feature-detection one.
//
// The URLs themselves are in `@stxapps/shared` (`stores/listings.ts`) because
// bracemark-site's landing page shows the same listings; only this picker is here,
// because only a browser app has a `navigator` to sniff — shared is
// `platform:agnostic` and compiles without the DOM lib.
//
// Guards `navigator` because callers are client components that Next still renders
// once on the server; the guessed value there is never shown (see previews-prompt.tsx,
// which renders null until a Dexie read resolves).
export function extensionStoreUrl(): string {
  if (typeof navigator === 'undefined') return CHROME_WEB_STORE_URL;
  return /firefox/i.test(navigator.userAgent) ? FIREFOX_ADDONS_URL : CHROME_WEB_STORE_URL;
}
