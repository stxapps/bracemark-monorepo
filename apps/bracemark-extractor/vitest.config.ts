import path from 'node:path';

import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig, type Plugin } from 'vitest/config';

// bracemark-extractor's tests run INSIDE the Workers runtime (workerd via miniflare),
// not on Node — so the handlers exercise the REAL `HTMLRewriter`, `fetch`,
// `AbortSignal.timeout`, and stream primitives they use in production, rather than
// Node polyfills that would encode our assumptions back at us.
//
// Unlike bracemark-api there are NO storage bindings to migrate (no D1/R2/DO): the
// extractor is a pure function. We point the pool at the committed `development`
// env, where the rate-limit bindings live (under env.*), so `environment` is
// required. Tests that fetch arbitrary URLs stub `globalThis.fetch`.
export default defineConfig({
  test: {},
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
        environment: 'development',
      },
    }),
    silenceUrlSourceRootWarning(),
  ],
});

// Drops ONE known-false Vite warning. Several of fb55's packages that linkedom pulls
// in for read mode (domutils, entities, css-select, nth-check) ship sourcemaps whose
// `sourceRoot` is a raw.githubusercontent.com URL. Vite (still in 8.3) resolves that
// URL as a filesystem path, fails, falls back to the cwd, and warns "Sourcemap for
// …/node_modules/domutils/lib/esm/index.js points to a source file outside its
// package: …/apps/bracemark-extractor/index.ts". Nothing is lost: the sources are
// remote, so there was nothing to inline. Landing under the cwd (this app's own
// folder, where no dependency's sources can live) is the signature we match, so a
// genuine outside-the-package map from any package still prints.
// `customLogger` would not work here, because Vitest replaces it with its own, so
// we wrap the resolved logger instead. Delete this once a run without it is clean.
function silenceUrlSourceRootWarning(): Plugin {
  const re = /points to a source file outside its package: "([^"]+)"/;
  return {
    name: 'bracemark:silence-url-sourceroot-warning',
    configResolved(config) {
      const warnOnce = config.logger.warnOnce.bind(config.logger);
      config.logger.warnOnce = (msg, options) => {
        const resolved = re.exec(msg)?.[1];
        if (resolved?.startsWith(process.cwd() + path.sep)) return;
        warnOnce(msg, options);
      };
    },
  };
}
