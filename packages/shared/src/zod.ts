import { z } from 'zod';

// THE ONLY PLACE `zod` IS IMPORTED FOR ITS VALUE. Everything else in the
// workspace takes `z` from here (inside `shared`: `from '../zod'`; outside it:
// `from '@stxapps/shared'`), and `eslint.config.mjs` restricts the bare
// 'zod' specifier to keep it that way. A type-only `import type { z } from 'zod'`
// is exempt and stays: it erases, so it constructs nothing.
//
// WHY: zod 4 JIT-compiles a "fastpass" parser for every object schema by
// building the function source as a string and handing it to `new Function`
// (`zod/v4/core/doc.ts`, `Doc.compile`). Before it does, it probes for eval
// support with `new Function('')` in a try/catch (`util.ts`, `allowsEval`).
// A caught throw is still a CSP violation event, so under bracemark-web's
// `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' …` — no 'unsafe-eval',
// deliberately (docs/hosting.md, _security headers_) — the probe alone reports
// one on every load, and under Report-Only it goes on to compile for real and
// report a second. `jitless` skips both; zod's own source says so at the probe.
//
// It costs nothing, because NO runtime we ship to can run the fastpass anyway:
// the browser is under the CSP above, Cloudflare Workers block eval outright
// (zod even sniffs the Workers UA), and Hermes has no eval. Every one of them
// was already falling back to the interpreted `superParse` path — via a probe
// that throws, on the wrong side of a CSP report. This makes that explicit.
//
// MUST BE SET BEFORE ANY SCHEMA IS BUILT, not before the first parse. The
// probe and the `jitless` read both happen in `$ZodObject`'s constructor
// (`schemas.js`: `const jit = !globalConfig.jitless; … allowsEval.value`), so
// they run when a module body evaluates `z.object(…)` — which for our contract
// schemas is import time. Configuring at an app entry point instead would be a
// race against ESM evaluation order, silent when lost. Re-exporting `z` from
// the module that configures it is what makes the ordering unlosable: you
// cannot get the binding without having run the call. Keep it that way — don't
// split this into a side-effect module someone can forget to import.
z.config({ jitless: true });

export { z };
