## browser extension

Notes on the `bracemark-extension` (wxt) app and how its UI/logic relates to
`bracemark-web`. See [architecture.md](./architecture.md) for the package layering
and dependency rules, and [account.md](./account.md) for the
password-derived account model the auth flows build on.

### wxt conventions

- **Use `browser.*` from wxt, not raw `chrome.*`.** wxt's `browser` namespace is
  Promise-based and cross-browser, so you don't hand-write callback wrappers or
  per-browser branches. Reach for `chrome.*` directly only for a Chrome-specific
  API with no standard equivalent (rare).
- **Entrypoints map to extension contexts.** wxt's `entrypoints/` directory is the
  contract: `background.ts` → the MV3 service worker; `popup/` → the quick-save +
  recent-list React app; `options/` → account / passphrase / key-management React
  app; `content.ts` → the programmatic content script (active-tab DOM read for the
  active-page extraction tier — see [link-extraction.md](./link-extraction.md)).
- **`bracemark-extension/utils/` is a WXT-reserved directory name** — don't rename it
  to `lib/` for consistency with the other apps/packages. WXT (like Nuxt) does
  directory-based auto-imports: it scans `utils/` (alongside `components/`,
  `composables/`, `hooks/`, and `entrypoints/`/`public/`/`assets/`) and
  regenerates `.wxt/types/imports-module.d.ts` + `.wxt/eslint-auto-imports.mjs`
  from it. Renaming the folder stops WXT from registering those modules into the
  `#imports` virtual module. `lib/` is our house style only for folders we
  organize freely (`bracemark-api/src/lib`, `web-react/src/lib`, the packages); the
  framework-reserved names stay as the framework expects.

### the popup and options surfaces

Both entrypoints render against the **same tokens bracemark-web does** —
`@stxapps/web-ui/styles.css`, achromatic `oklch(L 0 0)` greys, the shadcn
components — and **Inter is the only face**. bracemark-site's other two
(Bricolage for display, IBM Plex Mono for its instrument voice) exist to set
headlines and specimen panels; the extension has neither, and every font byte is
paid for on every popup open. Where the site reaches for mono, this surface
reaches for size and colour.

Four conventions hold the two entrypoints together. Breaking any of them is a
silent visual regression, so they're written down:

- **The frame owns the geometry.** `popup/Shell.tsx` declares the popup's width
  (`w-90` — 360px), the header, the 16px body padding and the footer slot;
  `options/Shell.tsx` declares the topbar, the `max-w-2xl px-6` measure and the
  section rhythm. Screens compose them and set no width of their own. Before
  this, six components each carried `w-85 p-4` and had already drifted.
- **The options page mirrors bracemark-web's settings scale exactly** — same
  measure, `text-xl font-semibold` page heading, `text-base font-medium`
  sections, `text-sm text-muted-foreground` descriptions, the same
  `has-data-checked:` radio rows. Both are "Settings" for one product and can sit
  in adjacent tabs; only the topbar's "Browser extension" label distinguishes
  them, and that's deliberate. **The other side of that mirror is now a real
  component**, not a convention two files agree to follow by hand:
  `bracemark-web/src/app/(app)/settings/_components/settings-kit.tsx` owns the
  measure, the heading steps, the bordered row and the notice tones for all
  eight sections there (its header comment carries the reasoning).
  **bracemark-expo has the third copy of that scale**, and it is a component too:
  `apps/bracemark-expo/src/features/settings/settings-kit.tsx`, same names, same
  steps, same `max-w-2xl px-6` measure, with web's `focus-visible:`/`hover:`
  states becoming `active:` because neither a keyboard nor a pointer exists
  there. So the product's settings scale now lives in **three** files —
  `OptionsShell` here, and one kit per app — and **nothing enforces their
  agreement**: no shared package, no test, and neither build can fail on the
  difference. If a scale step moves in one, move it in all three; this bullet is
  the only thing holding them together.
- **The page specimen is one component across the save.** `popup/PageSpecimen.tsx`
  renders the active tab in the editor and the saved link on the complete screen,
  and it does not move between them — the controls around it change instead. Its
  tile falls back extracted image → the live tab's `favIconUrl` (free from
  `tabs.query`, no network, no host disclosed) → `HostMonogram`, the same
  letter-on-hue tile bracemark-web's rows use, which now lives in
  `web-ui/components/links/host-monogram.tsx` so the popup and the library can't
  draw one host two ways. Its proportions are bracemark-site's hero panel: that
  hero is a drawing of this component.
- **Saving cuts the tile's corner** (`corner-cut` / `corner-square`, defined in
  the extension's `globals.css`). That 45° cut is the brand mark's own geometry —
  the turned-down page corner — and it is the whole "saved" signal: no check
  badge, no colour. The two clip paths are 5-point polygons with matching vertex
  counts so the change can transition on one property; keep them equal or it
  snaps.
- **Colour means attention, and nothing else.** The sync dot's healthy states are
  `bg-foreground/25` at rest and `bg-foreground/50 animate-pulse` while a cycle
  runs — distinguished by motion, not hue. Only `cycle-error`/`initial-error`
  (destructive) and `capacity-blocked` (amber) are chromatic. A green "all good"
  dot is the obvious move and the wrong one: it spends the surface's only colour
  on the state that needs no attention, and then the red has to shout over it.

### storage across extension contexts

The extension has three persistence layers, and which one to use depends on the
context that has to reach the data:

- **`browser.storage.local` / `.session`** — the primary cross-context store.
  Reach for it for state the background worker and the popup both touch, because
  the **popup's lifecycle is short** (it unmounts on close, so anything it holds
  in memory dies with it) and the **MV3 background service worker has no DOM and
  no `localStorage`** at all. `.session` is memory-backed and cleared on browser
  restart — the right home for ephemeral unlocked state.
- **IndexedDB** — for larger structured data and richer local querying (e.g. a
  local encrypted link index for search), available in both popup and background
  contexts. It is also where the extension keeps its **non-extractable
  `encryptionKey` `CryptoKey`** (structured-clone storable; `browser.storage`,
  being JSON-serialized, can't hold a `CryptoKey`) — the same `session-store.ts`
  shape bracemark-web uses, on the `chrome-extension://` origin. This is consistent
  with the extension deriving and holding its **own** key (see _the extension runs
  its own sign-in_ above). Dexie's reactivity crosses contexts here for free: it
  broadcasts each commit over a `BroadcastChannel`, which exists in the MV3
  service worker too, so a `useLiveQuery` in the open popup updates as the
  background's sync cycle writes — the popup doesn't have to poll or re-open to
  see synced data.
- **`localStorage`** — the popup/options pages have it (they're real pages on the
  `chrome-extension://` origin, and it does persist across popup closes), but the
  background worker doesn't, so it can't be the home for anything cross-context.
  Default to `browser.storage`. The one **deliberate exception** is
  web-react's `subscription-store.ts` (the last-known plan behind `useEntitlements`),
  and the reason is that it must be read **synchronously at first render** to seed
  react-query's `placeholderData`. `browser.storage.local` is async, so the popup —
  which remounts on every open, with a fresh `QueryClient` and therefore no warm
  query cache — would paint one frame of `FREE_SUBSCRIPTION_STATUS` each time, and
  `Editor`'s `useLinkQuota` gate would flash the `LinkQuotaBanner` at a paid
  account that's over the free cap. Don't "fix" that store to `browser.storage`
  without moving the read ahead of `createRoot().render()`. Two things make the
  trade cheap: the cache only gates client-side UX (the server re-checks the cap at
  `files/sign`), and it's shared code with bracemark-web, where `browser.*` doesn't
  exist at all.

  Note the flip side of that sharing: `background.ts` imports from the
  `@stxapps/web-react` barrel, so `subscription-store.ts` and `clear-data.ts` are
  in the service worker's module graph. They're safe there only because every
  access is inside a function and optional-chained (`globalThis.localStorage?.`) —
  nothing touches it at module scope. A background caller of
  `clearCachedSubscriptionStatus()` would therefore silently no-op rather than
  throw, leaving the cache for the next account on the device. Sign-out is
  popup-driven today; keep it that way, or mirror the clear through a message to
  the popup/offscreen context.

### the extension runs its own sign-in — it does not inherit the web session

The non-extractable `encryptionKey` (AES-256-GCM `CryptoKey`) can't cross the
web↔extension boundary: it lives in bracemark-web's IndexedDB on the `app.bracemark.com`
origin, and the extension runs on a separate `chrome-extension://` origin. So
the extension unlocks **on its own** — its own sign-in, deriving its own keys
from (username, password) via `@stxapps/web-crypto` — rather than reading the
web app's session. (This supersedes an earlier idea that the extension would
inherit the session out of shared storage.)

### auth code lives in the packages, not the web app

The auth flows and the rest of the shared local-first stack live in the
packages, not in `bracemark-web` — bracemark-web re-imports from them (single source of
truth), and the extension composes the same packages, importing **nothing** from
`bracemark-web` (apps never import apps).

The reusable primitives:

- form logic — `useCreateAccountForm`, `useSignInForm`, `useUsernameAvailable`
  in `@stxapps/react`
- schemas + endpoint descriptors in `@stxapps/shared`
- KDF / signing / AES in `@stxapps/web-crypto`
- inputs / buttons / fields in `@stxapps/web-ui`

The auth glue + local-first stack:

- `create-account-form.tsx`, `sign-in-form.tsx` →
  `@stxapps/web-ui/components/auth/*`
- `use-create-account.ts` / `use-sign-in.ts` / `use-sign-out.ts`,
  `auth-provider.tsx`, `sync-provider.tsx`, `session-store.ts`, the `data/*`
  store + the `sync/*` engine, and the `(app)/_hooks` editor family →
  `@stxapps/web-react` (see [architecture.md](./architecture.md)).

The auth submit hooks and the sync engine don't reach for an app-local
`@/lib/api`. They read the configured client through the `@stxapps/react`
seam — `useApiClient()` in the hooks, `SyncDeps.api` (threaded from the
provider) in the engine — so each app binds its own baseUrl. bracemark-web's
`lib/api.ts` stays app-local (it owns `NEXT_PUBLIC_API_URL`); the extension's
`utils/api.ts` is its counterpart (base URL from the build mode).
