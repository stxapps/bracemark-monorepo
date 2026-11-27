// The name the title/image collector (entrypoints/page-meta.ts) leaves its result
// under, in the page's isolated world, for `captureTitleImage` (utils/capture.ts) to
// read back with a second injection. Its own module so the collector's bundle pulls in
// one string and nothing else of the background's.
//
// Why a global at all: the collector is async, so the injected FILE's result is a
// Promise. Chrome and Firefox wait for it. Safari does not — it answers "JavaScript
// execution returned a result of an unsupported type" with a null result, and every
// save in Safari went `done` with no title and no image. A Promise returned by an
// injected FUNC is waited for in all three, so the background injects the file, then a
// func that returns this global (docs/browser-extension.md, _Safari — the Mac app_).
export const PAGE_META_GLOBAL = '__bracemarkPageMeta';
