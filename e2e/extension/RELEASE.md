# Browser extension release qualification

These checks cover browser chrome that the automated popup-tab harness cannot
represent. Record the browser version, build commit, and pass/fail result outside
the repository with the rest of the release evidence. Never put account
credentials in that record.

## Chrome toolbar active-tab grant

`@EXT-RELEASE-001` `@release` `@online` `@extension`

1. Run `npx nx build @stxapps/bracemark-extension`.
2. In the supported Chrome release, enable Developer mode at
   `chrome://extensions` and load
   `apps/bracemark-extension/.output/chrome-mv3` unpacked.
3. Sign in through the browser extension, then close its popup.
4. Open an unsaved HTTP page and invoke Bracemark through the real toolbar
   action. Confirm the editor identifies that page by its live title and URL.
5. Pick a list and tag, add a note, save, close the popup, and invoke the toolbar
   action again. Confirm the saved state appears.
6. Sync and confirm a separate signed-in web profile reads the saved link.

This is the only check that proves Chrome created the shipped manifest's
`activeTab` grant from a real toolbar invocation. The automated target stages a
copy with `tabs`, and its extraction case adds only the local web origin, so it
does not make this claim.

## Firefox production smoke

`@EXT-RELEASE-002` `@release` `@online` `@extension`

1. Run `npx nx build:firefox @stxapps/bracemark-extension` and
   `npx nx lint @stxapps/bracemark-extension`.
2. Run `npx web-ext lint --source-dir apps/bracemark-extension/.output/firefox-mv3`.
3. Load the production build temporarily in the supported Firefox release.
4. Sign in, save an unsaved HTTP page with a list/tag/note, close and reopen the
   popup, and confirm the saved state remains.
5. Request sync and confirm a separate signed-in web profile reads the link.
6. Open a video on www.youtube.com, then click another video **in the page** (no
   reload, so the address changes by `pushState`), and save it. Confirm the
   popup's preview shows the **second** video's title and thumbnail, and so does
   the synced row in the web profile.

Step 6 is the injected collector's check on a real site, and on the build as the
store gets it; `EXT-EXTRACT-003` (`npm run e2e:extension:firefox`) runs the same
collector in Firefox on every change, against pages it serves itself. It has failed
silently before: Firefox runs `page-meta.js` as a content script, where a DOM object's
iterator is not iterable, and a spread of one made every Firefox save arrive with
no title or image while Chrome and every spec passed
(`docs/link-extraction-keep.md`, _⚠ a page moved in place_). Step 4 alone does not
show it: a save with no preview still saves.

## Microsoft Edge toolbar and store install

`@EXT-RELEASE-003` `@release` `@online` `@extension`

1. Run `npm run e2e:extension:edge` against the Edge release under test. It runs
   every automated Chromium case in the system Edge, so this list covers only what
   that run cannot.
2. Run `npx nx build @stxapps/bracemark-extension`. In Edge, open
   `edge://extensions`, turn on Developer mode, and load
   `apps/bracemark-extension/.output/chrome-mv3` unpacked.
3. Edge puts a new extension inside its Extensions menu, not on the toolbar.
   Open that menu and choose **Show in toolbar** for Bracemark.
4. Sign in, then close the popup. Open an unsaved HTTP page and click the
   Bracemark toolbar button. Confirm the editor names that page by its live title
   and URL.
5. Pick a list and tag, add a note, save, close the popup, and click the toolbar
   button again. Confirm the saved state appears. Sync, and confirm a separate
   signed-in web profile reads the link.
6. After Edge Add-ons publishes the package, remove the unpacked copy, install
   Bracemark from its Edge Add-ons listing, and confirm its version at
   `edge://extensions` is the one `npm run zip:edge` recorded. Sign in and save one
   page.

Steps 3–5 are EXT-RELEASE-001 in Edge's own toolbar: only a real click creates
the shipped manifest's `activeTab` grant. Step 6 is the only check that runs the
package Edge delivers rather than one built here. Edge takes the Chrome package
unchanged, but its review is separate and on its own schedule.

## Safari, through the Mac app

`@EXT-RELEASE-004` `@release` `@online` `@extension`

1. Run `npx nx test @stxapps/bracemark-extension`. The Safari differences found
   so far are faked there, so a regression in one fails before any of this.
2. In `apps/bracemark-macos`, run `npm run app:staging`. If Bracemark is off in
   Safari Settings → Extensions, turn it on.
3. Click the Bracemark toolbar button. If the popup opens on _Allow Bracemark to
   connect_, press Continue and choose **Always Allow** in Safari's dialog.
4. Sign in with a **free** account. Open an article page that account has not
   saved, click the toolbar button, and save. Confirm that:
   - within a few seconds the saved screen's tile changes from a letter to the
     page's cover picture;
   - the saved screen has no _Keep a copy_ row, and no screen says "Upgrade";
   - the options page (the gear) has no _Keep a copy_ section, and its intro does
     not mention what a save keeps.
5. Sign out on the options page. Sign in with a **Plus** account and save another
   unsaved article. Confirm _Read mode_ gets its tick by itself, then press
   _Screenshot_ and confirm it gets one too. The options page shows the three
   _Keep a copy_ switches.
6. Sign in to bracemark-web in Safari with the same Plus account. If Safari
   offers to save the password, choose **Not Now**. From the popup, open _Read
   mode_ and _Screenshot_, and confirm the reader shows the article and the
   picture of the page. Confirm the link appears in the list with its cover.
7. Sign out of the browser extension and of bracemark-web.
8. Run step 4 against production on the build `npm run upload` sent. Install it
   with TestFlight, or open `build/Bracemark.xcarchive/Products/Applications/Bracemark.app`
   in `apps/bracemark-macos` (the same build before App Store re-signing), then
   quit and reopen Safari, which otherwise keeps the build it already loaded.
   Confirm the popup opens on _Allow Bracemark to connect_ for `api.bracemark.com`
   and that _Create an account_ opens `app.bracemark.com`.

There is no automated Safari run. Playwright's WebKit is not Safari and cannot
load a Safari web extension, and `safaridriver` runs separate automation windows
that have not been tried. Driving real Safari by script works, but it needs
three macOS permissions and the owner's own profile
(`docs/app-drivers.md`, _driving the browser extension in Safari_).

The cover in step 4 is the check for a bug only Safari had. Safari would not hand
back the title and image collector's answer, so every save arrived with no title
and no image, and every spec and every Chromium and Firefox run still passed
(`docs/browser-extension.md`, _Safari — the Mac app_). The rest of step 4 checks
that the Mac app offers nothing to buy, which App Review requires of it (the same
section, _no purchase calls to action in Safari_). Step 8 is the only check on
the build the Mac App Store will ship.
