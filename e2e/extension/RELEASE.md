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
