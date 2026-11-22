import { collectLivePageMeta } from '@stxapps/web-react/lib/page-meta';

// The title + preview-image candidates of the active tab, as a file the background
// injects (`captureTitleImage` in utils/capture.ts: `scripting.executeScript({ files:
// ['/page-meta.js'] })`). An UNLISTED script, like entrypoints/read-mode.ts: WXT bundles
// it into one self-contained file, lists it nowhere in the manifest, and makes `main`'s
// return value the injection's result.
//
// A file rather than an inline func because the collector is shared — expo's capture
// screen injects the same one into its WebView (web-react lib/page-meta.ts). It decides
// nothing: `selectTitleImage` runs in the background over what it returns.
//
// It returns a PROMISE when the tab's head went stale after an in-page move and is
// re-read from the tab's own address (web-react lib/page-meta.ts, _a stale head_);
// `executeScript` waits for it to settle and hands back its value.
export default defineUnlistedScript(() => collectLivePageMeta(document));
