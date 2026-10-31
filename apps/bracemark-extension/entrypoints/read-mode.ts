import { readerDocFromPage } from '@stxapps/web-react/lib/reader-doc-from-page';

// The read-mode capture, as a file the background injects into the active tab
// (`captureReadMode` in utils/capture.ts: `scripting.executeScript({ files:
// ['/read-mode.js'] })`). An UNLISTED script: WXT bundles it — Readability and the block
// converter with it — into one self-contained file, lists it nowhere in the manifest,
// and makes `main`'s return value the injection's result. Nothing runs it but that
// call, and that call only ever follows a popup the user opened on this tab.
export default defineUnlistedScript(() => readerDocFromPage(document));
