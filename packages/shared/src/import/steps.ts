// The two drivers every chunked import step shares. A step is written ONCE, as a
// generator that yields (nothing) at each point where it is safe to hand the
// thread back, and then run either straight through (the specs, the marketing
// site's bookmark converter) or with the platform's pause between yields (the
// import orchestrators: web-react / expo-react lib/yield-to-main.ts). One body
// for both, so the two entry points can't drift — the rule
// `projectImportedLinksInChunks` set first (docs/data-lifecycle.md, _main-thread
// cost_).

// Records a parser handles between two yields. Parsing's per-record cost is
// mostly `normalizeUrl`'s `new URL`, which on Hermes is expo's pure-JS WHATWG
// parser: about 50 ms per thousand links on the iOS simulator, where V8 does the
// same in about 7. Half that keeps a chunk well under ~50 ms on the simulator,
// and a real phone is slower still (docs/data-lifecycle.md, _readings — expo_).
export const PARSE_CHUNK = 500;

export function runSteps<T>(steps: Generator<void, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

export async function runStepsWithPauses<T>(
  steps: Generator<void, T>,
  pause: () => Promise<void>,
): Promise<T> {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await pause();
  }
}
