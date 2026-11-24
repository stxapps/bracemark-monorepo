// Stands in for `utils/target.ts` under jest (mapped in jest.config.cts), for
// the same reason as testing/web-app-url.ts: the real module reads
// `import.meta.env`, which babel won't compile for this runner. A spec that
// needs the Safari branch mocks `@/utils/target` with a getter instead
// (ApiAccess.spec.tsx).
export const IS_SAFARI = false;
export const API_HOST = 'localhost:8787';
export const API_ORIGINS = ['http://localhost:8787/*'];
