// A long-running job's progress tick: how many units are done, out of how many.
// One shape for every determinate counter in the apps — the blocking first sync's
// gate (sync/status.ts aliases it as InitialSyncProgressFn), the batched `files/`
// fetch behind an export, the export's own gather pass — so a UI that renders a bar
// can accept any of them without each caller re-spelling the signature.
//
// Two numbers rather than a struct because these fire PER UNIT: once per decrypted
// record on a first sync, several hundred times on a large library. The struct is
// allocated once per flush, by the consumer that throttles.
//
// `total` is a fact, not an estimate, at every site that reports one: each job counts
// its work before it starts (the first sync lists every file and subtracts what is
// already local, the export reads the namespace, the batched fetch counts the paths it
// will pull). A denominator that can't be invented is what lets the UI show a real bar
// instead of an indeterminate one easing toward 90%.
//
// `done` climbs monotonically to meet it, and every unit ticks exactly once —
// including the ones a run cannot finish (a path deleted between the listing and the
// GET, a URL that never came back). A counter that ignored those would stop short of
// its total and read as a hang.
export type ProgressFn = (done: number, total: number) => void;
