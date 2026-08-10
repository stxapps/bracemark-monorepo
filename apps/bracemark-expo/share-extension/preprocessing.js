// The iOS share extension's NSExtensionJavaScriptPreprocessingFile — Safari
// runs this INSIDE the shared page's context before opening the extension
// (wired by expo-share-extension's `preprocessingFile` option; the result
// lands on the RN root as `preprocessingResults`). This is the only place a
// page title exists without fetching the page, which the share sheet never
// does (docs/share-sheet.md). Shape consumed by src/features/share/share-url.ts.
//
// Safari's contract, not a module: it looks up the global
// `ExtensionPreprocessingJS` object and calls run(). Keep this file
// dependency-free ES5 — it executes in an arbitrary page, not in Metro — and
// keep the `var` (Apple's bridge resolves the name as a GLOBAL-OBJECT
// property, which a top-level const/let binding does not create).
// eslint-disable-next-line no-var, @typescript-eslint/no-unused-vars
var ExtensionPreprocessingJS = {
  run: function (args) {
    args.completionFunction({
      title: document.title,
      url: window.location.href,
    });
  },
};
