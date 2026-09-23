# Web release qualification

These checks own browser surfaces Playwright cannot drive honestly. Run them in
the supported production Chrome build against a disposable account. Do not stub
`showSaveFilePicker`: the native dialog and the file it creates are the boundary.

## DATA-EXPORT-WEB-RELEASE-001 — every offered format

`@DATA-EXPORT-WEB-RELEASE-001` `@release` `@online`

- [ ] Import the Phase 5 small Bracemark archive so the account has one link,
      one list, one tag, and one image.
- [ ] In Settings → Data → Export all data, choose **Bracemark backup**, export,
      and save the file through Chrome's native dialog. Verify the suggested and
      saved filename matches `Bracemark backup YYYY-MM-DD.zip`, then verify the
      receipt says `Exported 1 link and 1 file.`
- [ ] Repeat for **HTML bookmarks** and verify
      `Bracemark bookmarks YYYY-MM-DD.html` plus `Exported 1 link.`
- [ ] Repeat for **CSV** and verify `Bracemark bookmarks YYYY-MM-DD.csv` plus
      `Exported 1 link.`
- [ ] Repeat for **Plain text** and verify `Bracemark links YYYY-MM-DD.txt` plus
      `Exported 1 link.`
- [ ] Confirm all four files exist and are non-empty. Archive contents stay the
      unit/native-contract layer's responsibility.

## DATA-EMPTY-001 — a file still exists for an empty run

`@DATA-EMPTY-001` `@release` `@online`

- [ ] Use a fresh disposable account with no links.
- [ ] Export **Bracemark backup** through Chrome's native save dialog.
- [ ] Verify a non-empty `Bracemark backup YYYY-MM-DD.zip` file exists.
- [ ] Verify the receipt says: `The file was saved, but there were no links to
put in it.`

## PWA-RELEASE-001 — a real install, in real browser chrome

`@PWA-RELEASE-001` `@release` `@online` `@pwa`

`e2e-pwa` proves the production build, its manifest and its service worker
offline, but under automation Chrome never opens the app's standalone window,
so the app's own registration trigger (`display-mode: standalone`,
`inner-layout.tsx`) and the install surfaces themselves are unproven there
(docs/e2e.md, _the PWA target_). Display-mode emulation is not installation.

Run against the release candidate on its real origin (staging or production —
an `https` origin; a LAN `http` address is not a secure context and registers
no worker, docs/device-testing.md), with a disposable account, on each of:
desktop Chrome (macOS), Chrome on a real Android phone, and Safari's Add to
Home Screen on a real iPhone.

- [ ] Install through the browser's own surface (the address-bar install
      button / menu **Install**; Android **Add to Home screen → Install**; iOS
      Share → **Add to Home Screen**). Record the prompt's name and icon match
      the manifest.
- [ ] Launch from the installed icon. The window has no browser chrome and
      `/links` loads signed in after one sign-in.
- [ ] In the installed window's devtools (desktop) or remote inspector, confirm
      a service worker is **activated** for the origin with no prior manual
      registration — the app's standalone branch registered it.
- [ ] Save one link, let it sync, then close the app completely.
- [ ] Turn the network off (Wi-Fi and cellular / airplane mode). Launch from the
      icon: the app shell and the saved link appear, and switching to Show All
      and back works without an error page.
- [ ] Still offline, save a second link. The ⋯ menu reports the failed sync.
- [ ] Turn the network back on and press **Sync failed — Retry**. On a second
      device or browser signed into the same account, Sync shows the second link.
- [ ] Uninstall through the platform's own surface and record that the icon is
      gone.
