import { app } from './app';

// Cloudflare Workers entry. The Workers runtime calls `fetch(request, env, ctx)` on
// the default export, and Hono's `app` is exactly that handler. This is the only
// entry — bracemark-extractor runs solely on Workers (no Node entry), so config always
// comes from `c.env` (wrangler.jsonc vars/bindings); see app.ts.
//
// Unlike bracemark-api there are no Durable Object classes to export here — the extractor
// is stateless (no D1/R2/DO), a pure function with no per-user storage.
export default app;
