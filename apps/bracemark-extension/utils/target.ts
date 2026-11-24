// Which browser this build is for, and the api origin it talks to — both decided
// at build time. They sit in their own module because `import.meta` has no
// CommonJS spelling, so jest maps this file to testing/target.ts
// (jest.config.cts), the same way it maps web-app-url.ts.

// WXT defines SAFARI as a build-time boolean from `-b safari`.
export const IS_SAFARI = import.meta.env.SAFARI === true;

const apiUrl = new URL(import.meta.env.WXT_PUBLIC_API_URL);

// The api host as the user reads it, e.g. "api.bracemark.com".
export const API_HOST = apiUrl.host;

// The one host permission the manifest asks for (wxt.config.ts builds the same
// pattern). Safari doesn't grant it at install, so the popup has to ask for it
// (entrypoints/popup/ApiAccess.tsx).
export const API_ORIGINS = [`${apiUrl.origin}/*`];
