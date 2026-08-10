// Every public store listing Bracemark has, and the one-of-them a given visitor
// should be sent to. These are addresses of the SAME artifacts from two different
// repos-worth of surfaces, which is why they live here rather than in either app:
//
//   - bracemark-site (the marketing apex) shows the full badge row on the landing
//     page — all four listings at once.
//   - bracemark-web (the app) shows a single browser-extension button in the links
//     page's previews prompt, via `extensionStoreUrl()`.
//
// A second copy would be a drift hazard with a deadline: all four are placeholders
// until submission (below), and the day they're filled in, one copy would be
// updated and the other forgotten.
//
// "Browser extension" throughout, never bare "extension" (docs/architecture.md —
// _naming_): bracemark-expo has an iOS share extension that is a different thing.
//
// Hard-coded, not env-configured, because a store listing is a fixed public address
// — unlike the app's own origins, these are the same in every environment.
//
// TODO: all four are PLACEHOLDERS. The values they replaced addressed the legacy
// Brace.to listings (`com.bracedotto`, App Store id 1531456778, and the Chrome one
// by its v1 extension id — which is what the Web Store actually resolves, the slug
// is decorative), and Bracemark gets brand-new listings on every store because the
// identifiers change. Fill these in at submission time; until then
// they link nowhere rather than to the wrong product.

// Data only, no picker. Choosing WHICH browser-extension listing to offer a visitor
// is a UA sniff, and this package is `platform:agnostic` — it compiles without the
// DOM lib, so `navigator` doesn't exist here. That chooser lives with the browser
// that has one: apps/bracemark-web/src/lib/extension-stores.ts.

export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/bracemark/TODO_EXTENSION_ID';
export const FIREFOX_ADDONS_URL = 'https://addons.mozilla.org/en-US/firefox/addon/bracemark/';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.bracemark.app';
export const APP_STORE_URL = 'https://apps.apple.com/us/app/idTODO_APP_STORE_ID';
