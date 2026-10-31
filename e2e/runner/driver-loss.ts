import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Maestro's iOS driver is one XCTest method serving HTTP, and on every hierarchy
// request it walks SpringBoard's status bars, whose tree reaches the keyboard's
// window in the InputUI process. When InputUI drops that window mid-walk, XCTest
// records a failure that `try?` cannot catch, the method unwinds, and the server
// goes with it: `DeviceUnreachableException`, connection refused, on whatever step
// the flow happened to be on (docs/app-drivers.md, _the status-bar race_).
//
// The fetch is the whole signature on purpose. It walks SpringBoard, never the app,
// so an app that crashed fails an app query and does not match, and neither does the
// same AX error surfacing as a logged "Ignoring failure to get hierarchy", which
// XCTest absorbs and which most runs carry several of.
const FATAL_RESOLVE = 'testHttpServer] : Failed to resolve query: Failed to resolve remote element';
const FETCH_START = 'Fetch status bar hierarchy - start';
const FETCH_END = 'Fetch status bar hierarchy - duration';

export function diedInStatusBarFetch(runnerLog: string): boolean {
  const failure = runnerLog.indexOf(FATAL_RESOLVE);
  if (failure === -1) return false;
  const before = runnerLog.slice(0, failure);
  return before.lastIndexOf(FETCH_START) > before.lastIndexOf(FETCH_END);
}

// A step's report and its runner log are paired by suffix (`junit-2.xml`,
// `maestro-2/`), so a passed step's log can never vouch for a later step's failure.
export async function lostDriverToStatusBarRace(caseDir: string): Promise<boolean> {
  for (const entry of await readdir(caseDir)) {
    const step = /^junit(-\d+)?\.xml$/.exec(entry);
    if (!step) continue;
    const report = await readFile(join(caseDir, entry), 'utf8');
    if (!report.includes('maestro.DeviceUnreachableException')) continue;

    const outputDir = join(caseDir, `maestro${step[1] ?? ''}`);
    const files = await readdir(outputDir, { recursive: true }).catch(() => []);
    for (const file of files) {
      if (!/xctest_runner_[^/]*\.log$/.test(file)) continue;
      if (diedInStatusBarFetch(await readFile(join(outputDir, file), 'utf8'))) return true;
    }
  }
  return false;
}
