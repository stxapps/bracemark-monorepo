import { collectPageMeta } from '@stxapps/web-react/lib/page-meta';

// The title + preview-image candidates of the active tab, as a file the background
// injects (`captureTitleImage` in utils/capture.ts: `scripting.executeScript({ files:
// ['/page-meta.js'] })`). An UNLISTED script, like entrypoints/read-mode.ts: WXT bundles
// it into one self-contained file, lists it nowhere in the manifest, and makes `main`'s
// return value the injection's result.
//
// A file rather than an inline func because the collector is shared — expo's capture
// screen injects the same one into its WebView (web-react lib/page-meta.ts). It decides
// nothing: `selectTitleImage` runs in the background over what it returns.
export default defineUnlistedScript(() => collectPageMeta(document));
