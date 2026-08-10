// Ambient types for the `cloudflare:test` virtual module (env, createExecutionContext,
// waitOnExecutionContext, …) that @cloudflare/vitest-pool-workers injects at test time.
// The package's MAIN types don't declare the module — only its `./types` subpath does —
// so reference that subpath explicitly. Lives under `test/` so ONLY the spec typecheck
// pass picks it up (tsconfig.app.json excludes `test/`), keeping the strict app pass free
// of test-only globals.
/// <reference types="@cloudflare/vitest-pool-workers/types" />
