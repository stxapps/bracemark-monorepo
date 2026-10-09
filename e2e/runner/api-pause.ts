import { requireLocalEnvironment } from './environment';
import { capture } from './process';
import { assertOriginOwnedByRepo } from './stack';

// Freeze the local api process, slow it, and thaw it again — the one network
// fault both simulators can be given. The iOS simulator shares this Mac's
// loopback, so it has no per-device route to remove the way Android's
// `adb reverse` does (docs/e2e.md, _gestures and waits the runner performs_);
// signalling the process is the lever that is left.
//
// The fault is a HANG, not a refusal: the kernel still accepts the connection
// into the listen backlog, and the request waits for a process that is not
// running. Nothing is dropped — on SIGCONT every held request is served — which
// is what a stalled server looks like to a client, and unlike removing the api
// it leaves the dev stack exactly as it was. `throttle` alternates the two, so
// the server keeps answering at a fraction of its speed: a slow link, for a
// state that would otherwise pass faster than a driver can look at it.
//
// It stalls every client of the local api at once, so it belongs only in the
// serial native runner, between flows that are the only client running. A
// frozen api outliving the runner would wedge every later run on this machine
// with nothing to say why, so the thaw is also registered on process exit and
// on the signals a developer sends a runner.

const API_PORT = 8787;

export interface ApiControl {
  // Stopped for `stoppedMs` of every `stoppedMs + runningMs`.
  throttle(stoppedMs?: number, runningMs?: number): void;
  pause(): void;
  resume(): void;
}

async function apiPid(): Promise<number> {
  requireLocalEnvironment('API process fault injection');
  // Only this checkout's api may be touched.
  await assertOriginOwnedByRepo(`http://localhost:${API_PORT}`, 'bracemark-api', {
    required: true,
  });
  const result = await capture('lsof', ['-nP', `-iTCP:${API_PORT}`, '-sTCP:LISTEN', '-t']);
  const pids = [...new Set(result.stdout.split(/\s+/).filter(Boolean))];
  if (pids.length !== 1) throw new Error(`expected one api listener, found ${pids.join(', ')}`);
  return Number(pids[0]);
}

export async function controlApi(): Promise<ApiControl> {
  const pid = await apiPid();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const signal = (name: 'SIGSTOP' | 'SIGCONT') => {
    try {
      process.kill(pid, name);
      stopped = name === 'SIGSTOP';
    } catch {
      // Gone; nothing is left frozen.
      stopped = false;
    }
  };
  const halt = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const thaw = () => {
    halt();
    if (stopped) signal('SIGCONT');
  };
  const onSignal = (name: NodeJS.Signals) => {
    thaw();
    process.exit(name === 'SIGINT' ? 130 : 143);
  };
  process.on('exit', thaw);
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return {
    throttle(stoppedMs = 900, runningMs = 100) {
      halt();
      const cycle = () => {
        signal('SIGSTOP');
        timer = setTimeout(() => {
          signal('SIGCONT');
          timer = setTimeout(cycle, runningMs);
        }, stoppedMs);
      };
      cycle();
    },
    pause() {
      halt();
      signal('SIGSTOP');
    },
    resume() {
      thaw();
      process.off('exit', thaw);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}
