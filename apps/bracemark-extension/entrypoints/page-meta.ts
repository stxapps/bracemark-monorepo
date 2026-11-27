import { collectLivePageMeta } from '@stxapps/web-react/lib/page-meta';

import { PAGE_META_GLOBAL } from '@/utils/page-meta-global';

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
// It returns a PROMISE (the collector is async: a tab whose head went stale after an
// in-page move is re-read from its own address — web-react lib/page-meta.ts, _a stale
// head_), and Safari will not hand a file's Promise back. So the Promise is also left
// on a global, which the background reads with a second, func injection
// (utils/page-meta-global.ts). The return value stays for any caller that can use it.
export default defineUnlistedScript(() => {
  const meta = collectLivePageMeta(document);
  (globalThis as Record<string, unknown>)[PAGE_META_GLOBAL] = meta;
  return meta;
});
