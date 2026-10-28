import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { METRO_URL } from './native';

// A Hermes CPU profile of the app's JS thread over the Chrome DevTools Protocol,
// through Metro's inspector proxy — docs/e2e.md, _finding what owns a native
// stall_, as a function. The stall probe says how long the thread was held; this
// says by what, which is the question a fix starts from.
//
// The render runner opens one around a leg's window when it runs with
// `--profile` (render-mobile.ts). That bundle is served unminified, so the
// frames carry their names; a profile on the minified one names nothing.
//
// ⚠ Only the `React Native` runtime, never the Reanimated `UI` one: attaching
// the profiler there killed the app inside `CDPHandlerImpl::processPendingFuncs`
// (docs/e2e.md, same section). `pickTarget` refuses to guess between two.

interface InspectorTarget {
  title?: string;
  description?: string;
  webSocketDebuggerUrl?: string;
}

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
}

interface ProfileNode {
  id: number;
  callFrame: CallFrame;
  children?: number[];
}

interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

export interface ProfileSummary {
  // Sampled time with the thread doing anything at all, idle excluded.
  busyMs: number;
  // Fabric's host calls — the shadow tree's node creation, the commit (diff and
  // Yoga layout) — against everything else, which is JS: React and the app.
  hostMs: number;
  // Per function, by name: time on the stack (inclusive) and at its top
  // (self). `components` is inclusive with React's own frames left out, which
  // is where a component's render shows: React calls it from a scheduler loop
  // that is on every stack and so tops every inclusive list.
  components: [string, number][];
  self: [string, number][];
}

// Frames that are the sampler's own bookkeeping, not code. Hermes parks its
// idle samples on `[root]`.
const IDLE = new Set(['(idle)', '(root)', '(program)', '[root]']);

// React's reconciler and scheduler, by function name — on the stack under every
// component, so they are dropped from `components`. Names, not a file: the
// bundle is one file.
const REACT_INTERNAL =
  /^(workLoop|renderRoot|performWork|performSync|performUnitOfWork|flushSync|processRoot|completeUnitOfWork|completeWork|beginWork|renderWithHooks|update[A-Z]\w*Component|updateFunctionComponent|updateForwardRef|updateMemoComponent|updateSimpleMemoComponent|updateContextProvider|reconcile|commit|recursivelyTraverse|mountIndeterminateComponent|finishConcurrentRender|flushPassiveEffects|flushSyncWork|scheduleUpdateOnFiber|dispatch|batchedUpdates|runWithPriority|unstable_runWithPriority|callCallback|\(anonymous\))/;

export async function startProfile(): Promise<{ stop(path: string): Promise<ProfileSummary> }> {
  const targets = (await (await fetch(`${METRO_URL}/json/list`)).json()) as InspectorTarget[];
  const target = pickTarget(targets);
  const ws = new WebSocket(target);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`could not open ${target}`)), {
      once: true,
    });
  });

  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(e: Error): void }>();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    // Events (no id) are the runtime's chatter; only replies are awaited.
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = <T>(method: string, params: object = {}) =>
    new Promise<T>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  // `Profiler.enable` is answered "Unsupported method" by the app's Hermes
  // (RN's modern inspector, 2026-10-28), and `Profiler.start` works without it,
  // so both enables are courtesies; only a failed start is fatal.
  await send('Runtime.enable').catch(() => undefined);
  await send('Profiler.enable').catch(() => undefined);
  await send('Profiler.start');
  return {
    async stop(path) {
      const { profile } = await send<{ profile: CpuProfile }>('Profiler.stop');
      ws.close();
      await writeFile(path, JSON.stringify(profile));
      return summarize(profile);
    },
  };
}

// The app's JS runtime among Metro's targets. Hermes lists the app's runtime as
// `React Native …` and Reanimated's worklet runtime beside it; the second must
// never be attached (see ⚠ above), so anything but exactly one match refuses.
function pickTarget(targets: InspectorTarget[]): string {
  const label = (t: InspectorTarget) => `${t.title ?? ''} | ${t.description ?? ''}`;
  const urls = targets.flatMap((t) =>
    t.webSocketDebuggerUrl && /React Native/.test(label(t)) && !/\bUI\b/.test(label(t))
      ? [t.webSocketDebuggerUrl]
      : [],
  );
  if (urls.length !== 1) {
    throw new Error(
      `expected one React Native inspector target, found ${urls.length}: ` +
        (targets.map(label).join('; ') || 'none — is the app connected to Metro?'),
    );
  }
  return urls[0];
}

// Self and inclusive time per function name. Inclusive counts a sample once per
// function however deep the recursion, so a name's figure is the time anything
// under it was running: a component's is its render, `completeRoot`'s is
// Fabric's commit, which is the split a row's cost comes apart into.
export function summarize(profile: CpuProfile, top = 15): ProfileSummary {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id);
  }
  // The function and its line: the bundle is one file, so the line is what tells
  // two `Row`s apart. Host and runtime frames (`[Host Function] …`) have none.
  const name = (node: ProfileNode) => {
    const fn = node.callFrame.functionName || '(anonymous)';
    return node.callFrame.url && !fn.startsWith('[')
      ? `${fn}:${node.callFrame.lineNumber + 1}`
      : fn;
  };

  const self = new Map<string, number>();
  const inclusive = new Map<string, number>();
  let busy = 0;
  let host = 0;
  profile.samples.forEach((id, i) => {
    // A sample's time is the delta to the NEXT one: what ran until it.
    const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    const leaf = byId.get(id);
    if (!leaf || IDLE.has(leaf.callFrame.functionName)) return;
    busy += ms;
    if (leaf.callFrame.functionName.startsWith('[Host Function]')) host += ms;
    self.set(name(leaf), (self.get(name(leaf)) ?? 0) + ms);
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const node = byId.get(at);
      if (!node || IDLE.has(node.callFrame.functionName)) continue;
      if (REACT_INTERNAL.test(node.callFrame.functionName || '(anonymous)')) continue;
      const key = name(node);
      if (seen.has(key)) continue;
      seen.add(key);
      inclusive.set(key, (inclusive.get(key) ?? 0) + ms);
    }
  });
  const ranked = (map: Map<string, number>) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([key, ms]): [string, number] => [key, Math.round(ms)]);
  return {
    busyMs: Math.round(busy),
    hostMs: Math.round(host),
    components: ranked(inclusive),
    self: ranked(self),
  };
}

export function printSummary(name: string, summary: ProfileSummary): void {
  console.log(
    `  profile ${name}: ${summary.busyMs} ms busy, ${summary.hostMs} ms of it Fabric host calls`,
  );
  console.log('    components (inclusive, React internals left out):');
  for (const [fn, ms] of summary.components)
    console.log(`      ${String(ms).padStart(6)} ms  ${fn}`);
  console.log('    self:');
  for (const [fn, ms] of summary.self) console.log(`      ${String(ms).padStart(6)} ms  ${fn}`);
}

// `tsx measure/hermes-profile.ts <file.cpuprofile> [top]` — summarize a profile a
// run already wrote, at whatever depth, without running anything again.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, top] = process.argv.slice(2);
  if (!path) throw new Error('usage: tsx measure/hermes-profile.ts <file.cpuprofile> [top]');
  const profile = JSON.parse(await readFile(path, 'utf8')) as CpuProfile;
  printSummary(path, summarize(profile, top ? Number(top) : 15));
}
