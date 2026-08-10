import { app } from './app';

// Durable Object classes must be EXPORTED from the entry module so the Workers
// runtime can discover and instantiate them for the `USER_DATA` binding
// (wrangler.jsonc → durable_objects + migrations). See src/do/user-data.ts.
export { UserDataDO } from './do/user-data';

// Cloudflare Workers entry. The Workers runtime calls `fetch(request, env, ctx)`
// on the default export, and Hono's `app` is exactly that handler. This is the
// only entry — bracemark-api runs solely on Workers (no Node entry), so config
// always comes from `c.env` (wrangler.jsonc vars/bindings); see app.ts.
export default app;
