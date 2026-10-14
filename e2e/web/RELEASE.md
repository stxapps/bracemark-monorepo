# Web release qualification

Automated staging checks now run through the separate staging targets; see
[STAGING.md](../STAGING.md). Optimized Release builds can be driven by Maestro;
the manual cases here remain for the platform/store boundaries that the admitted
automated suite does not prove. A staging subset pass does not complete this
checklist.

These checks own browser surfaces Playwright cannot drive honestly. Run them in
the supported production Chrome build against a disposable account. Do not stub
`showSaveFilePicker`: the native dialog and the file it creates are the boundary.

## DATA-EXPORT-WEB-RELEASE-001 — the backup through Chrome's save dialog

`@DATA-EXPORT-WEB-RELEASE-001` `@release` `@online`

The one export path no driver can take: Chrome saves a Bracemark backup through
`showSaveFilePicker`'s native dialog. Everything else about exporting is
automated — the three interop formats on Chrome and Firefox
(`DATA-ROUNDTRIP-WEB-001`) and the backup through Firefox's download
(`DATA-ROUNDTRIP-WEB-002`), each with its file name, its receipt, and an import
of the file into a fresh account.

- [ ] Import the Phase 5 small Bracemark archive so the account has one link,
      one list, one tag, and one image.
- [ ] In Chrome, Settings → Data → Export all data, choose **Bracemark backup**,
      export, and save the file through the native dialog. Verify the suggested
      and saved filename matches `Bracemark backup YYYY-MM-DD.zip`, the receipt
      says `Exported 1 link and 1 file.`, and the saved file is non-empty.
- [ ] Cancel the dialog on a second export and confirm no error is shown.

## DATA-EMPTY-001 — a file still exists for an empty run

`@DATA-EMPTY-001` `@release` `@online`

- [ ] Use a fresh disposable account with no links.
- [ ] Export **Bracemark backup** through Chrome's native save dialog.
- [ ] Verify a non-empty `Bracemark backup YYYY-MM-DD.zip` file exists.
- [ ] Verify the receipt says: `The file was saved, but there were no links to
put in it.`

## PWA-RELEASE-001 — a real install and a real update, in real browsers

`@PWA-RELEASE-001` `@release` `@online` `@pwa`

`e2e-pwa` proves the production build, its manifest and its service worker —
offline, and through an update (`PWA-007`–`011`) — but only in Chrome, only
against its own static server, and under automation Chrome never opens the
app's standalone window (docs/e2e.md, _the PWA target_). What is left for a
person: the install surfaces themselves, the same journey in Safari and Firefox,
and an update delivered by the real CDN. Display-mode emulation is not
installation.

Run against the release candidate on its real origin (staging or production —
an `https` origin; a LAN `http` address is not a secure context and registers
no worker, docs/device-testing.md), with a disposable account. The app registers
its worker at sign-in in **any** display mode (docs/offline-mode.md, _when the
worker registers_), so a browser with no install surface still runs Parts B and
C in a tab.

| browser                      | A — install                        | B — offline | C — update |
| ---------------------------- | ---------------------------------- | ----------- | ---------- |
| Chrome, desktop (macOS)      | address-bar install button         | yes         | yes        |
| Chrome, a real Android phone | **Add to Home screen → Install**   | yes         | yes        |
| Safari, a real iPhone        | Share → **Add to Home Screen**     | yes         | yes        |
| Safari, desktop (macOS)      | File → **Add to Dock**             | yes         | yes        |
| Firefox, desktop (macOS)     | none — run B and C in a normal tab | yes         | yes        |

### A — install

- [ ] Install through the browser's own surface (the table above). Record the
      prompt's name and icon match the manifest.
- [ ] Launch from the installed icon. The window has no browser chrome and
      `/links` loads signed in after one sign-in.
- [ ] After every other part: uninstall through the platform's own surface and
      record that the icon is gone.

### B — the worker, offline

- [ ] Sign in (in the installed window, or in a tab where there is no install).
      In devtools → Application → Service workers (Safari: Develop → Service
      Workers; Firefox: `about:debugging` → This Firefox; a phone: the remote
      inspector), confirm a worker is **activated** for the origin with no manual
      registration — the app registered it at sign-in.
- [ ] Save one link, let it sync, then close the app or the tab completely.
- [ ] Turn the network off (Wi-Fi and cellular / airplane mode). Open the app
      again: the app shell and the saved link appear, and switching to Show All
      and back works without an error page.
- [ ] Still offline, save a second link. The ⋯ menu reports the failed sync.
- [ ] Turn the network back on and press **Sync failed — Retry**. On a second
      device or browser signed into the same account, Sync shows the second link.

### C — an update from the real host

This is the one check of an update on the real CDN and in a browser that is not
Chrome. It needs **two deploys to staging** — build 1 is what Parts A and B ran
on; build 2 is a later commit with any change to the app. (Rebuilding the same
commit will not do: Nx restores the cached build, which is the same build with
the same stamp, and nothing new is deployed.) `npm run deploy:web:staging` must
finish with its worker check green both times (docs/hosting.md, _deploying the
static sites_).

**Which build a window is on** is `document.documentElement.dataset.build` in its
console; **which build the installed worker holds** is the `id` in `/build.json`
fetched from that same console (`await (await fetch('/build.json')).json()`).
Note build 1's value before deploying build 2.

- [ ] On build 1, online, open `/links` and leave that window open. Open a
      second window or tab on `/links` too.
- [ ] Deploy build 2. In the **second** window, reload: its `dataset.build` is
      build 2's on the first reload (the page comes from the network —
      docs/offline-mode.md, _what answers a navigation_).
- [ ] Within about a minute the **first** window — still build 1 — shows
      **Bracemark was updated**. The second window does **not**: it is already
      build 2, and the new worker only caught up with it. Before pressing
      anything, save a link in the first window: it still works.
- [ ] Press **Reload** in the first window: `dataset.build` is build 2's and the
      pill is gone. The link saved a moment ago is still listed.
- [ ] `/build.json` answers build 2 in both windows, and in the same
      service-worker inspector as Part B exactly one worker is listed for the
      origin, **activated**, none stuck **installing** or **waiting**.
- [ ] Close every window of the app. Turn the network off. Open the app: it
      opens, the library is there, and `dataset.build` is build 2's. This is the
      step that proves the new worker's precache replaced the old one; online, a
      page is build 2 either way.
- [ ] Turn the network back on.

## IAP-PADDLE-RELEASE-001 — a real sandbox checkout, end to end

`@IAP-PADDLE-RELEASE-001` `@release` `@online` `@internet`

`IAP-WEB-001` opens the real overlay and closes it; everything past the close is
here, because it takes a card, a webhook and a live sandbox subscription that
has to be cancelled afterwards (docs/e2e.md, _what e2e may not assert_). Run it
after any change to the Paddle config or the checkout path, against staging (its
webhook destination is registered) or against the local api through a tunnel
(docs/iap.md, _exercising Paddle locally_), with a disposable account.

- [ ] `npm run check:paddle -- <tier>` passes first: the price on sale, its
      `tax_mode`, the product's `tax_category` and the default payment link are
      dashboard state nothing else checks.
- [ ] Settings → Subscription on the free account: the Plus card shows Paddle's
      price for this buyer, not `$48/year`. **Upgrade to Plus** opens the overlay
      in the app's current light/dark theme.
- [ ] The overlay states the free trial and its length, and the same number of
      days the pricing page promises. Pay with a sandbox test card (the overlay's
      **View Testing Instructions** lists them), completing 3DS if asked.
- [ ] After the overlay closes the section says **Finishing your upgrade…**, then
      **You're on Plus now — thank you.** within about 30 seconds. The plan box
      reads Plus with **free trial**, and "Free trial — your first payment is on
      <date>" names the trial's end.
- [ ] The api's log shows the `subscription.created` event applied (no
      `IAP_DROP` token), and the account's `paddle_checkouts` row is gone.
- [ ] **Lost webhook.** Repeat with a second disposable account while the
      webhook destination is paused. The section still flips to Plus inside its
      poll, through the pending checkout's pull (docs/iap.md, _reconciliation_).
      Re-enable the destination.
- [ ] **Manage billing** opens Paddle's customer portal in a new tab. Cancel the
      subscription there, return, press **Refresh**: "Free trial ends on <date> —
      you won't be charged." The plan stays Plus until that date.
- [ ] Clean up: cancel both sandbox subscriptions immediately (dashboard or
      `POST /subscriptions/{id}/cancel` with `effective_from: immediately`), so
      the next run's checkout is not refused as `already_subscribed`.
