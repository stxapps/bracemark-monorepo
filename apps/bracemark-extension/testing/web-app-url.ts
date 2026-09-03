// Stands in for `utils/web-app-url.ts` under jest (mapped in jest.config.cts).
//
// The real module is three `import.meta.env.MODE` branches and nothing else, and
// `import.meta` has no CommonJS spelling — babel refuses to compile it for this
// runner. There is no behaviour there to pin either: the branch is decided by the
// build mode, and which of the three origins is correct is a fact about
// `.env.<mode>`, not about the code. So specs assert that a surface opens
// `${WEB_APP_URL}/<path>`, against the value the development build resolves to.
export const WEB_APP_URL = 'http://localhost:3000';
