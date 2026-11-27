import { APP_STORE_URL, CHROME_WEB_STORE_URL, FIREFOX_ADDONS_URL } from '@stxapps/shared';

// The browser-extension listing to offer THIS browser, or null where no browser
// extension can be installed. A UA sniff is the honest tool here: what's being
// chosen is which STORE can install into this browser, which is a browser-identity
// question, not a feature-detection one.
//
//   - **Phones and tablets: null.** No mobile browser takes a Bracemark browser
//     extension (bracemark-expo has a share extension, not a Safari one), so a store
//     button would lead nowhere useful. iPadOS Safari asks for desktop sites by
//     default and says "Macintosh" — only its touch points give it away, which is why
//     this reads `maxTouchPoints` and not the UA alone.
//   - **Firefox: AMO.**
//   - **Safari on a Mac: the App Store.** Safari takes a browser extension only inside
//     an app, and the Mac app (bracemark-macos) shares the iOS app's record, so
//     `APP_STORE_URL` is its listing too (docs/browser-extension.md, _Safari — the
//     Mac app_). Tested by the `Version/…Safari/` pair that only Safari's UA has, with
//     the Chromium names excluded because their UAs say "Safari" as well.
//   - **Everything else: the Chrome Web Store** — Chrome, and the rest of the Chromium
//     family. Edge installs from it after one "Allow extensions from other stores"
//     click; `@stxapps/shared` has no Edge Add-ons address yet, and when it does,
//     Edge gets its own branch here.
//
// The URLs themselves are in `@stxapps/shared` (`stores/listings.ts`) because
// bracemark-site's landing page shows the same listings; only this picker is here,
// because only a browser app has a `navigator` to sniff — shared is
// `platform:agnostic` and compiles without the DOM lib.
//
// Guards `navigator` because callers are client components that Next still renders
// once on the server; the guessed value there is never shown (see previews-prompt.tsx,
// which renders null until a Dexie read resolves).
export function extensionStoreUrl(): string | null {
  if (typeof navigator === 'undefined') return CHROME_WEB_STORE_URL;
  const ua = navigator.userAgent;

  const mobile =
    /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (mobile) return null;

  if (/firefox/i.test(ua)) return FIREFOX_ADDONS_URL;
  if (/Version\/[\d.]+.*Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)) {
    return APP_STORE_URL;
  }
  return CHROME_WEB_STORE_URL;
}
