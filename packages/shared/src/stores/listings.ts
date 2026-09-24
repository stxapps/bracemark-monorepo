// Every public store listing Bracemark has, and the one-of-them a given visitor
// should be sent to. These are addresses of the SAME artifacts from two different
// repos-worth of surfaces, which is why they live here rather than in either app:
//
//   - bracemark-site (the marketing apex) shows the full badge row on the landing
//     page — all four listings at once.
//   - bracemark-web (the app) shows a single browser-extension button in the links
//     page's previews prompt, via `extensionStoreUrl()`.
//   - bracemark-expo opens its own platform's listing from Settings → About's
//     "Rate Bracemark" row (lib/review-prompt.ts) — read from here rather than
//     from `ios.appStoreUrl` / `android.playStoreUrl` in app.config.ts, which
//     would be a copy.
//
// A second copy would be a drift hazard: the day a listing moves, one copy would be
// updated and the other forgotten.
//
// "Browser extension" throughout, never bare "extension" (docs/architecture.md —
// _naming_): bracemark-expo has an iOS share extension that is a different thing.
//
// Hard-coded, not env-configured, because a store listing is a fixed public address
// — unlike the app's own origins, these are the same in every environment.
//
// Bracemark gets brand-new listings on every store, never the legacy Brace.to ones
// (`com.bracedotto`, App Store id 1531456778, the v1 Chrome extension id), because
// the identifiers change. Each URL is keyed by the identifier its store actually
// resolves, and every one of them is fixed before review, not by it — so a listing
// still in review is a dead link here, never a wrong one:
//
//   - Chrome: the extension id the Web Store assigned at first upload (dashboard →
//     the item). The `/bracemark/` slug is decorative. NOT the id an unpacked build
//     gets — the manifest carries no `key`, so each unpacked load has its own.
//   - App Store: the numeric Apple ID (App Store Connect → App Information). No
//     country segment, so each visitor lands on their own storefront.
//   - Firefox: the slug set on the AMO listing, `bracemark` — AMO resolves by slug.
//   - Play: the package name, `package` in apps/bracemark-expo/app.config.ts.

// Data only, no picker. Choosing WHICH browser-extension listing to offer a visitor
// is a UA sniff, and this package is `platform:agnostic` — it compiles without the
// DOM lib, so `navigator` doesn't exist here. That chooser lives with the browser
// that has one: apps/bracemark-web/src/lib/extension-stores.ts.

export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/bracemark/geddbkhciieeichmhpflpkaamjglgbjo';
export const FIREFOX_ADDONS_URL = 'https://addons.mozilla.org/en-US/firefox/addon/bracemark/';
export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.bracemark.app';
export const APP_STORE_URL = 'https://apps.apple.com/app/id6814343506';
