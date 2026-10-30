## browser extension

Notes on the `bracemark-extension` (wxt) app and how its UI/logic relates to
`bracemark-web`. See [architecture.md](./architecture.md) for the package layering
and dependency rules, and [account.md](./account.md) for the
password-unlocked account model the auth flows build on.

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
- **Test helpers live in `testing/`, and that is not an arbitrary choice either.**
  WXT auto-imports everything under the reserved directories, so a fake `browser`
  parked in `utils/` would be registered into `#imports` and become a global the
  real bundle can reach. `testing/` is invisible to WXT (and excluded from Nx's
  `production` inputs, so editing a helper doesn't invalidate the build cache).
  See [testing.md](./testing.md), _the shared jest plumbing_, for what has to be
  faked here and why — `browser` and `defineBackground` are auto-imports, so
  under jest they have to be real globals.
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

Five conventions hold the two entrypoints together. Breaking any of them is a
silent visual regression, so they're written down:

- **The frame owns the geometry.** `popup/Shell.tsx` declares the popup's width
  (`w-90` — 360px), the header, the 16px body padding and the footer slot;
  `options/Shell.tsx` declares the `max-w-2xl px-4 md:px-6` measure, the footer
  and the section rhythm. Screens compose them and set no width of their own.
  Before this, six components each carried `w-85 p-4` and had already drifted.
  The inset steps at `md` for a reason that belongs to bracemark-web — a settings
  section there can be a table that runs out of width on a phone — and no host
  embeds the options page that wide, so it renders at its 16px inset in practice;
  the `md:` half is declared anyway, because the parity below is a promise about
  what the two files SAY. **That never-matching `md:` is not always harmless**,
  which is the next bullet: it also governs web-ui's control type step, and there
  it silently gave a desktop settings page a phone's 16px fields.
- **The options page has no header, and that's the config's doing.**
  `options/index.html` pins `manifest.open_in_tab: false`, so the page only ever
  renders embedded — Chrome's options dialog on `chrome://extensions`, Firefox's
  Preferences tab in `about:addons` — reached solely through the popup's
  `runtime.openOptionsPage()`. Both hosts already draw the icon, the name and a
  close affordance above the document, so the topbar this page used to carry (icon
  - wordmark + a "Browser extension" label) was a second copy of the host's own
    chrome, disambiguating it from bracemark-web's Settings in a place where the two
    cannot sit side by side. The meta tag carries the reasoning; **turning it on
    means restoring the header in the same change**, because a bare options tab has
    no chrome naming the product at all.
- **The options page mirrors bracemark-web's settings scale exactly** — same
  measure, `text-xl font-semibold` page heading, `text-base font-medium`
  sections, `text-sm text-muted-foreground` descriptions, the same
  `has-data-checked:` radio rows. Both are "Settings" for one product, so a user
  who has seen one shouldn't be able to tell they've changed apps. Note that
  neither host gives the embedded page the full 672px — the measure is a ceiling
  kept for parity, not a width the page reaches today. **The other side of that mirror is now a real
  component**, not a convention two files agree to follow by hand:
  `bracemark-web/src/app/(app)/settings/_components/settings-kit.tsx` owns the
  measure, the heading steps, the bordered row and the notice tones for all
  eight sections there (its header comment carries the reasoning).
  **bracemark-expo has the third copy of that scale**, and it is a component too:
  `apps/bracemark-expo/src/features/settings/settings-kit.tsx`, same names, same
  steps, same `max-w-2xl px-4 md:px-6` measure, with web's `focus-visible:`/`hover:`
  states becoming `active:` because neither a keyboard nor a pointer exists
  there. So the product's settings scale now lives in **three** files —
  `OptionsShell` here, and one kit per app — and **nothing enforces their
  agreement**: no shared package, no test, and neither build can fail on the
  difference. If a scale step moves in one, move it in all three; this bullet is
  the only thing holding them together. **The steps are 32 / 16 / 8 / 12** —
  section to section, a block's heading to its content, a tab strip to the panel
  it heads, one row to the next — written as `gap-8` on the pane and `gap-4` on
  the group in both kits, and as `mt-8` on the sections here, since this page has
  no flex column to hold a gap. The last two come free from `Tabs` and
  `RadioGroup` and only need leaving alone: they were being overridden by a `mt-4`
  inside each tab panel, which put the Sync/Device pills further from the radios
  they govern than from the heading above. Prior to that fix the scale was
  24 / 12 / 8 / 12, in which a section break and a heading's own content measured
  the same — with no dividers and no cards, spacing is the only thing grouping
  these blocks, so each step has to be legibly its own size.
- **Both entrypoints pin web-ui's control type step back to the desktop tier,
  because `md:` is a proxy for "touch phone" and neither document is one.**
  web-ui's five controls — `Input`, `Textarea`, both combobox triggers
  (`ListSelect`, `TagsField`) and `CommandInput` — render at 16px below `md` and
  14px at or above it, to stop iOS Safari zooming a focused sub-16px field
  (`input.tsx` carries the argument). Neither of this app's documents ever matches
  `md:`: the toolbar popup's viewport IS its 360px frame, since the browser sizes
  the window to the document, and no host embeds the options page at 768px. So
  every control here took the phone branch **on a desktop, with a mouse and
  nothing to zoom** — a 16px note field beside 14px pickers in the popup's
  `Editor`, 16px sign-in fields, and two 16px time inputs on a Settings page whose
  whole claim is that it matches bracemark-web's scale. `styles/globals.css` fixes
  all six in one unlayered rule naming the five selectors. It is a **rule, not a
  class per call site**, because three of those controls come from `SignInForm`,
  which bracemark-web also renders and which must keep 16px on a phone. The list
  is exhaustive by hand and **nothing enforces it** — a new web-ui control that
  joins the step lands here at 16px with no lint error, no type error and no
  failing test.
- **The popup runs the `dense` label tier, and the shared auth form has a prop
  for it.** `Label`'s `density="dense"` (`text-xs`, muted) against the `standard`
  `text-sm`; `Editor.tsx` uses it for List/Tags/Note. `SignInForm` is shared with
  bracemark-web, which wants `standard`, so the tier is a **prop** —
  `<SignInForm density="dense" />` — not a class override. The reason is the
  popup's own scale rather than the control size above: left at `standard` it made
  the popup's 14px `PopupTitle` and its 14px field labels one weight apart and
  nothing else, so a page heading read as a peer of a field name. (That argument
  is why the tier survived the control step landing on 14px — it never depended on
  the 16px value, and a 14px label would tie `PopupTitle` either way.) The
  resulting scale on a popup screen is two body tiers: **14px for the
  `PopupTitle`, the Button and every control's value, 12px muted for every
  caption, label and aside**, under the header's 15px lockup — which is also what
  a link editor looks like on bracemark-web at desktop width, the parity the step
  above buys. `FieldError` stays at
  14px in both tiers on purpose — an error must not be quieter than the label it
  corrects, and it is already differentiated by colour rather than by size
  ([accessibility.md](./accessibility.md)). `CreateAccountForm` has no such prop
  because the popup never renders it: the extension does its own sign-in but
  never creates accounts, and its footer opens the web app in a tab instead.
- **The page specimen is one component across the save.** `popup/PageSpecimen.tsx`
  renders the active tab in the editor and the saved link on the complete screen,
  and it does not move between them — the controls around it change instead. Its
  tile falls back extracted image → the live tab's `favIconUrl` (free from
  `tabs.query`, no network, no host disclosed) → `HostMonogram`, the same
  letter-on-hue tile that fills an icon-less row's preview slot in
  bracemark-web (the chip beside a row's host line falls back to a plate — this
  popup prints no host chip, so the escalation below is uncontested here), which
  now lives in
  `web-ui/components/links/host-monogram.tsx` so the popup and the library can't
  draw one host two ways. Its proportions are bracemark-site's hero panel: that
  hero is a drawing of this component.
- **The specimen's slot is the library row's, `h-10 w-16`.** Four surfaces draw a
  saved link — bracemark-web's list row (and the skeleton that stands in for it),
  bracemark-expo's row, this popup specimen and the share sheet's — and until
  recently only the two specimens were square, so the one component whose job is
  "the page, as the library will draw it" was the one drawing it differently.
  16:10 is also the shape of what lands in the slot: an `og:image` is a landscape
  capture, and a square cropped it harder here than the library crops the same
  bytes. The hero panel moved with them. The cost is width — `w-90` minus `p-4`
  leaves ~250px for the title where the square left ~270 — which two lines of
  15px absorb. Inside the slot both fallbacks are a centred square on the muted
  plate: the favicon at `size-6`, because it is a 16–32px bitmap that must not be
  scaled past its pixels, and the monogram at `size-10` — the slot's full height —
  because it is a vector. Neither fills the WIDTH: that would stretch the square
  monogram — so `HostMonogram` grew a `ratio` (and an `rx`, for when the parent
  already clips): the viewBox widens with the box, the letter stays round and
  centred, and the field fills. The favicon does not get the same treatment; it is
  a 16–32px **bitmap** and stays `size-6`, `object-contain`, centred on the muted
  plate. That split is an escalation, not an inconsistency — the plate stays quiet
  while there is a real mark to show, and the hue field appears only when the
  monogram is the last identity left. It also means the corner cut lands on a
  filled rectangle in all three states, which is what makes a turned-down corner
  read as one. (Not to be confused with `link-media.tsx`'s `panel` fallback, the
  CARD's image-less banner: same hue family, but a fixed `text-4xl` letter rather
  than a fraction of the box.)
- **Saving cuts the tile's corner** (`corner-cut` / `corner-square`, defined in
  the extension's `globals.css`). That 45° cut is the brand mark's own geometry —
  the turned-down page corner — performed on the thing the user just kept. It is
  **not** the whole "saved" signal, though both specimens' headers said so for a
  long time: `Complete.tsx` sets the `PopupTitle` to "Saved", names the list, and
  replaces the form with "Open Bracemark", and the share sheet does the same. The
  words carry the state; the fold is the part of the confirmation that happens to
  the OBJECT, which is why the specimen doesn't move across the save. The two clip
  paths are 5-point polygons with matching vertex counts so the change can
  transition on one property; keep them equal or it snaps.
- **Colour means attention, and nothing else.** The sync dot's healthy states are
  `bg-foreground/25` at rest and `bg-foreground/50 animate-pulse` while a cycle
  runs — distinguished by motion, not hue. Only `cycle-error`/`initial-error`
  (destructive) and `capacity-blocked` (amber) are chromatic. A green "all good"
  dot is the obvious move and the wrong one: it spends the surface's only colour
  on the state that needs no attention, and then the red has to shout over it.
  The pill's progress follows the same rule: while a run has a number, the
  pill's own top hairline fills in `bg-foreground/50` and the percent sits
  beside the label — the footer's existing line, not a new element, so the pill
  at rest is unchanged. The full count and the real progressbar are the detail
  view's (`popup/Sync.tsx`).

### storage across extension contexts

The extension has three persistence layers, and which one to use depends on the
context that has to reach the data:

- **`browser.storage.local` / `.session`** — the primary cross-context store.
  Reach for it for state the background worker and the popup both touch, because
  the **popup's lifecycle is short** (it unmounts on close, so anything it holds
  in memory dies with it) and the **MV3 background service worker has no DOM and
  no `localStorage`** at all. `.session` is memory-backed and cleared on browser
  restart — the right home for ephemeral unlocked state.
  The sync mirror (`utils/mirrored-sync.ts`, read through
  `hooks/use-mirrored-sync.ts`) uses both, split by how often it changes: the
  status is `.local`, written a few times a cycle and read on every popup open;
  the **progress** (the count behind the pill's percent and the detail view's
  bar) is `.session`, written up to ten times a second through
  `@stxapps/shared`'s `createProgressCoalescer` and removed when the run ends.
  Folding the progress into the status record would rewrite a persisted value
  per tick and re-render every `useSync()` consumer with it. Both hooks read the
  key once and then follow `storage.onChanged`. A change that arrives before
  that first read resolves wins over the read. Otherwise the older value from
  the read would overwrite it, and for the status that stale value would stay
  up until the next cycle's write.
- **The worker's copy of the status mirror is seeded from storage, never from
  the initial state.** An MV3 worker is torn down idle and spun up cold for the
  next trigger, and a copy seeded with `INITIAL_MIRRORED_SYNC_STATE` made each
  such cycle's first write `storeStatus: 'checking', lastSyncAt: null` — the
  popup read "Checking…" and "Last sync: Never" for the whole cycle on a device
  that had synced a minute before. The runner also writes the gate's answer
  (`ready` / `syncing-initial`) in the same write as `bgSyncStatus: 'syncing'`,
  and a failed first pull as `storeStatus: 'error'`, so the popup offers its
  Retry instead of "Setting up this device…" over an error (`utils/sync-runner.ts`).
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

### a cycle outlives the idle timeout

**Both browsers kill the background 30 s after its last extension-API call** —
Firefox's event page (`extensions.background.idle.timeout`) and Chrome's MV3
service worker alike — and neither counts a `fetch` or an IndexedDB write as
activity. While the popup is open, the view holds the page up; once it closes,
the clock runs. A sync cycle is almost nothing but fetches and IndexedDB
writes, and a large library's **first pull is silent for minutes**: it reports
no progress until its listing ends (`startPull`, web-react `engine.ts` — a total
that grew under the bar would be fake progress), so it makes no `browser.*`
call at all, and the progress mirror's `storage.session` writes that would have
counted start too late. The specimen: signing in on Firefox with a big library,
the pull ran while the popup was open and stopped ~30 s after it closed. It
resumed (a first pull resumes where it stopped) only on the next wake — the
popup reopened, or the hourly alarm — so it crawled forward an hour at a time,
while the mirror, last written by the dead worker, still read "syncing".

`utils/sync-runner.ts` fixes it with **one call doing two jobs**, for exactly
as long as `inflight`:

- **The keepalive.** Every 20 s the run re-creates a one-shot alarm,
  `bracemark-sync-resume`. That is an extension-API call, which resets the idle
  timer in both browsers (Firefox resets it on every background call that
  reaches the parent — `"parentapicall"` in `ext-backgroundPage.js`; Chrome on
  any API call since 110).
- **The dead-man's switch.** Each re-create pushes the alarm a minute out, so a
  healthy run never lets it fire, and the run's `finally` clears it. A worker
  killed anyway — Chrome's caps on one fetch response (30 s) and on one event
  (5 min), a crash — leaves it standing; it wakes a fresh worker a minute later,
  and that worker's spin-up kick is the resume. `background.ts` deliberately
  gives the alarm no branch: running a cycle there too would only queue a
  trailing rerun behind the one the spin-up already started.

Three things are easy to get wrong here:

- **It is not a keepalive for an idle worker.** Mozilla calls that an
  anti-pattern and Chrome's docs agree; this lives and dies with the run.
- **A FAILED run clears the alarm too.** Left standing, it would retry an
  error every minute with no backoff — the loop the runner's "a failed cycle
  drops the rerun" rule exists to prevent. Retrying an error stays a fresh
  kick's job.
- **Firefox's `alarms.create` returns `undefined`**, not the `Promise<void>`
  WXT's types declare, so a `.catch` chained straight onto it throws. The
  runner awaits it inside an async function instead.

Asking the user to hold the popup open was the alternative, and the wrong one:
Firefox closes the popup on any click outside it, and it would cover only the
cycles the popup started — not the alarm's, nor a save's.

**Debugging it hides it.** Firefox never suspends an event page while a DevTools
toolbox is attached to the extension, so reproduce with the toolbox closed (and
`extensions.background.idle.timeout` lowered in `about:config` to see it sooner).

### the extension runs its own sign-in — it does not inherit the web session

The non-extractable `encryptionKey` (AES-256-GCM `CryptoKey`) can't cross the
web↔extension boundary: it lives in bracemark-web's IndexedDB on the `app.bracemark.com`
origin, and the extension runs on a separate `chrome-extension://` origin. So
the extension unlocks **on its own** — its own sign-in, deriving its own keys
from (username, password) via `@stxapps/web-crypto` — rather than reading the
web app's session. (This supersedes an earlier idea that the extension would
inherit the session out of shared storage.) Which of its contexts may act on a
401, and which must never, is in [sessions.md](./sessions.md), _who acts on a
401_ — the popup and options page run the `AuthProvider` and own the session;
the background worker only reads its state, and while it is `expired` calls
nothing (`utils/sync-runner.ts` mirrors `paused`). The popup's sync pill reads
"Sync paused — sign in to resume", and its detail view opens a `Resume` view:
the shared sign-in form with the username locked. What it can still open with
the server gone is in [offline-mode.md](./offline-mode.md), _the browser
extension_.

**The sign-in is the popup's alone.** The options page has none of its own. Its
signed-out screen (`options/App.tsx`, `SignedOut`) is usually reached by signing
out on that page, and its "Sign in" button opens the toolbar popup with
`action.openPopup()`. When the popup signs in, the session broadcast
(`session-store.ts`, over a `BroadcastChannel`) switches the options page to the
signed-in view with no reload. A second sign-in form there was considered and
dropped. It would need its own `setArgon2Runner('main')` (only `popup/main.tsx`
sets it, and the worker path is stubbed out of the bundle, so a sign-in on the
options page would throw), its own create-account link and resume view, all
inside a host's options dialog. Two constraints on the button, neither of which
fails a test:

- **`openPopup` is Chrome 127+, and the floor is 111.** It is feature-detected.
  Where it is missing, or the call is rejected, the screen falls back to "click
  the Bracemark icon in your browser toolbar".
- **Firefox only honours it inside a user gesture.** The call has to be the
  first thing the click handler does. An `await` ahead of it loses the gesture,
  and the button falls back to the text instead.

### opening bracemark-web — the tab keeps the page's Firefox container

The popup sends the user to bracemark-web for what it doesn't do itself: "Open
Bracemark" on the complete page, "Upgrade to Plus" when the library is full, and
"Create an account" on sign-in. Because the session doesn't carry across (above),
what the new tab shows depends on bracemark-web's session **in that tab's cookie
store**. In Firefox that store is per container, and a tab an extension creates
opens in the **default** container unless it asks for another. So someone signed
in to bracemark-web only inside "Personal" would click "Open Bracemark" and land on
the sign-in page, and a click on "Upgrade" would send them to sign in before they
could pay. All three buttons therefore go through `utils/open-web-app.ts`. It reads
the active tab's `cookieStoreId` when the button is clicked and passes it to
`tabs.create`.

- **The permission is Firefox-only.** Reading `Tab.cookieStoreId` needs nothing,
  but creating a tab with it needs `cookies`. That permission shows no install or
  update prompt in Firefox, so existing users update silently.
  `wxt.config.ts` adds it to the Firefox build only. Chrome has no containers, and
  it would be an unused permission there.
- **Pass it only when it's present.** Chrome tabs have no `cookieStoreId`, and
  Chrome's `tabs.create` rejects an option it doesn't know. If the container has
  gone by the time of the click (deleted, or containers switched off), the helper
  retries without it rather than leave the button doing nothing.
- **Not for the options page.** Its "Open Bracemark" keeps a plain `tabs.create`,
  because it is embedded in about:addons, which `openOptionsPage()` opens in the
  default container. There is no container there to copy.

Nothing fails when this regresses. The tab still opens, only on bracemark-web's
sign-in page, and only for Firefox users who use containers.

### the functional E2E target and the toolbar boundary

`npx nx e2e-extension @stxapps/e2e` drives the development MV3 build in
Playwright's bundled Chromium against `npm run dev`;
`npx nx e2e-extension:staging @stxapps/e2e` drives the staging build against
the deployed dryrunbase.com tier (`e2e/STAGING.md`, _browser extension_). It uses a
persistent profile because the extension's non-extractable key is stored in
IndexedDB and must survive popup and browser restart. Every case owns a
disposable account, and cross-client checks read through a separate
bracemark-web profile.

The attachable popup is `popup.html` in a tab. That tab cannot receive the
toolbar gesture that creates the shipped `activeTab` grant, so the harness
stages a run-artifact copy with `tabs`; the extraction case adds only the
run's web origin (local or staging) so its controlled title/image page can be
injected. Neither permission change touches the build output or manifest
source. This proves the popup, local store, background messages, sync, and MV3
worker restart, but it deliberately does not prove the real toolbar click.
`e2e/extension/RELEASE.md` owns that Chrome check and the supported Firefox
production smoke.

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

### the Firefox data-collection disclosure

`browser_specific_settings.gecko.data_collection_permissions` in `wxt.config.ts`
is **store copy, not config** — Firefox renders those strings verbatim on the
install consent screen. It has been mandatory for new extensions since
2025-11-03 (AMO rejects a submission without it; WXT warns on every
`npm run dev:firefox` until it's set), and the honest list for this extension is
three `required` types with no `optional` ones:

| type                 | what leaves the device                                                                               |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `authenticationInfo` | the username + the signed proof the password unlocks, per _the extension runs its own sign-in_ above |
| `browsingActivity`   | the saved link's specific URL                                                                        |
| `websiteContent`     | title, `og:image` bytes, viewport screenshot, read-mode + page-copy HTML (`utils/capture.ts`)        |

Three things about that table are easy to get wrong later:

- **End-to-end encryption doesn't shorten it.** Mozilla's test is transmission
  off the device, not whether we can read what we transmit.
- **`bookmarksInfo` is not ours to claim.** It means _Firefox_ bookmarks — the
  `bookmarks` API, which this extension neither requests nor calls. Declaring it
  for our own saved links tells users we read their bookmark tree: a worse
  disclosure, not a more cautious one.
- **`technicalAndInteraction` must stay off.** There is no analytics, telemetry
  or crash reporting in this app, and listing it would contradict "No ads, no
  trackers, no analytics code" in `packages/shared/src/stores/listing-copy.ts`.
  The totals we count on the server (/privacy, _How we use what we collect_)
  come from session and file records every client already sends; the browser
  extension sends nothing new for them, so they do not move this facet.

The list is a claim about the API surface, so **a facet that sends something new
to bracemark-api revisits it in the same change** — nothing in the build can
notice that it has gone stale. Full definitions:
[Firefox built-in data consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/).
Chrome's equivalent isn't a manifest key at all — it's the Privacy tab in the
Web Store dashboard, filled in by hand at submission; keep the two answers
saying the same thing.

### the browser floors are derived, not a support policy

`strict_min_version` (140.0, Android 142.0) and `minimum_chrome_version` (111)
look like taste and aren't. **Both are the highest floor our dependencies
impose, and nothing more:**

| floor            | Firefox | Chrome | why                                                                                         |
| ---------------- | ------- | ------ | ------------------------------------------------------------------------------------------- |
| Vite's JS target | 114     | 111    | `baseline-widely-available`; re-check on a Vite major, it moves                             |
| Tailwind v4 CSS  | 128     | 111    | `@property` / `color-mix()` — the oklch token system, so below it the popup _renders wrong_ |
| the disclosure   | 140     | —      | `data_collection_permissions` is ignored below it (Android: 142)                            |

Firefox 140 is also the current ESR, so every version it excludes is both
unsupported by Mozilla and already broken by Tailwind. Chrome has no third row —
its disclosure lives in the Web Store dashboard — which is why the two numbers
sit three years apart. That asymmetry is correct; don't "align" them.

**Do not track these to the latest release minus a few.** They gate install and
_update delivery_, not testing: a browser below the floor silently stops
receiving new versions, so every bump strands whoever installed under the old
one — which makes raising a floor the expensive direction and a rolling window
the worst of both. Too high costs reach and buys no quality; too low is the real
bug, and it was one — `minimum_chrome_version` was `'93'`, three CSS generations
under what Tailwind v4 needs, so Chrome would have installed the extension and
drawn an unstyled popup. Set each floor at the true minimum, and move it only
when a dependency's own floor moves. `npx web-ext lint --source-dir
.output/firefox-mv3` is the check on the Firefox side: it flags any manifest key
newer than the declared minimum (`KEY_FIREFOX_*UNSUPPORTED_BY_MIN_VERSION`).
