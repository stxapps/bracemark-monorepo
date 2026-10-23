import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { VISUAL_BASELINES, visualRunDir } from '../paths';
import { writeJson } from './lib';
import { decodePng, diffRasters, encodePng, meanLuma, type Raster } from './pixels';
import {
  expectedCaptures,
  readVisualCatalog,
  type VisualCatalog,
  type VisualPlatform,
} from './visual-catalog';
import { type E2EWidth } from './width';

// Compare what a visual run captured with the accepted baseline, and say so in a
// report a person reads (docs/e2e.md, _visual checkpoints_).
//
// REVIEW-ONLY BY DEFAULT (VISUAL-006). A changed capture is listed, diffed and
// kept, and fails nothing — unless its checkpoint is `gate: true` in
// e2e/visual.json, which is a deliberate, owned promotion made after the history
// below shows the capture holding still. What DOES fail every run, gated or not,
// is the harness failing its own contract: a capture the catalog owes that was
// never taken, or a `dark` capture that is not darker than its `light` twin —
// the flip that did not land, which would otherwise be accepted as a baseline.

export type Verdict = 'new' | 'same' | 'changed' | 'size-changed' | 'missing';

export interface CaptureResult {
  key: string;
  checkpoint: string;
  verdict: Verdict;
  ratio?: number;
  gate: boolean;
  // Consecutive runs this capture has matched its baseline, this one included.
  streak: number;
  problem?: string;
}

interface History {
  [key: string]: { streak: number; runs: number; lastVerdict: Verdict; lastRunId: string };
}

// A dark capture must be clearly darker than its light twin. Measured: the
// app's light screens average ~220–240 luma and its dark ones ~20–50, so this is
// far from both, while a flip that never landed reads as a ratio of ~1.
const DARK_TO_LIGHT_MAX = 0.8;

export function capturesDir(runDir: string): string {
  return join(visualRunDir(runDir), 'captures');
}

// One baseline directory per device profile: a raster is only comparable with
// one taken on the same browser build, simulator model or AVD and OS.
export function profileDir(profile: string): string {
  return join(VISUAL_BASELINES, profile.replace(/[^A-Za-z0-9._-]+/g, '-'));
}

async function readRaster(path: string): Promise<Raster> {
  return decodePng(await readFile(path));
}

export async function compareVisualRun(options: {
  runId: string;
  runDir: string;
  profile: string;
  platform: VisualPlatform;
  caseIds: string[];
  // A native run's device width: what a wide iOS run cannot capture is not
  // owed (visual-catalog.ts, `capturedAt`).
  width?: E2EWidth;
  accept: boolean;
  catalog?: VisualCatalog;
}): Promise<{ failed: boolean; results: CaptureResult[] }> {
  const catalog = options.catalog ?? readVisualCatalog();
  const { channelTolerance, changedRatio, promotionStreak } = catalog.comparison;
  const visualDir = visualRunDir(options.runDir);
  const current = capturesDir(options.runDir);
  const baselines = profileDir(options.profile);
  const historyPath = join(baselines, 'history.json');
  const history: History = existsSync(historyPath)
    ? (JSON.parse(await readFile(historyPath, 'utf8')) as History)
    : {};

  const expected = expectedCaptures(options.caseIds, options.platform, catalog, options.width);
  const results: CaptureResult[] = [];
  const rasters = new Map<string, Raster>();

  for (const { key, checkpoint } of expected) {
    const path = join(current, `${key}.png`);
    const base = { key, checkpoint: checkpoint.id, gate: checkpoint.gate, streak: 0 };
    if (!existsSync(path)) {
      results.push({ ...base, verdict: 'missing', problem: 'never captured' });
      continue;
    }
    const raster = await readRaster(path);
    rasters.set(key, raster);

    const baselinePath = join(baselines, `${key}.png`);
    if (!existsSync(baselinePath)) {
      results.push({ ...base, verdict: 'new' });
      continue;
    }
    const compared = diffRasters(await readRaster(baselinePath), raster, channelTolerance);
    if (!compared) {
      results.push({ ...base, verdict: 'size-changed' });
      continue;
    }
    if (compared.ratio <= changedRatio) {
      results.push({ ...base, verdict: 'same', ratio: compared.ratio });
      continue;
    }
    await mkdir(join(visualDir, 'diff'), { recursive: true });
    await mkdir(join(visualDir, 'baseline'), { recursive: true });
    await writeFile(join(visualDir, 'diff', `${key}.png`), encodePng(compared.diff));
    await copyFile(baselinePath, join(visualDir, 'baseline', `${key}.png`));
    results.push({ ...base, verdict: 'changed', ratio: compared.ratio });
  }

  // The dark half of every pair must be dark.
  for (const { key, checkpoint, variant } of expected) {
    if (variant.appearance !== 'dark') continue;
    const lightKey = key.replace(/\.dark$/, '.light');
    const dark = rasters.get(key);
    const light = rasters.get(lightKey);
    if (!dark || !light) continue;
    const ratio = meanLuma(dark) / Math.max(meanLuma(light), 1);
    if (ratio > DARK_TO_LIGHT_MAX) {
      const result = results.find((candidate) => candidate.key === key);
      if (result) {
        result.problem =
          `${checkpoint.id}: the dark capture is not darker than the light one ` +
          `(luma ratio ${ratio.toFixed(2)}) — the appearance did not switch`;
      }
    }
  }

  for (const result of results) {
    const previous = history[result.key];
    const streak = result.verdict === 'same' ? (previous?.streak ?? 0) + 1 : 0;
    result.streak = streak;
    history[result.key] = {
      streak,
      runs: (previous?.runs ?? 0) + 1,
      lastVerdict: result.verdict,
      lastRunId: options.runId,
    };
  }

  const blocking = results.filter(
    (result) =>
      result.problem !== undefined ||
      (result.gate && (result.verdict === 'changed' || result.verdict === 'size-changed')),
  );
  const failed = blocking.length > 0;

  await mkdir(baselines, { recursive: true });
  if (options.accept && !failed) {
    for (const result of results) {
      await copyFile(join(current, `${result.key}.png`), join(baselines, `${result.key}.png`));
      if (result.verdict !== 'same') history[result.key].streak = 0;
    }
  }
  await writeJson(historyPath, history);

  const report = {
    runId: options.runId,
    platform: options.platform,
    profile: options.profile,
    baselines: relative(visualDir, baselines),
    accepted: options.accept && !failed,
    comparison: catalog.comparison,
    results,
  };
  await writeJson(join(visualDir, 'report.json'), report);
  await writeFile(join(visualDir, 'report.html'), reportHtml(report, promotionStreak), 'utf8');

  printSummary(results, promotionStreak, options.accept && !failed);
  console.log(`visual report: ${join(visualDir, 'report.html')}`);
  return { failed, results };
}

function printSummary(results: CaptureResult[], promotionStreak: number, accepted: boolean) {
  const count = (verdict: Verdict) => results.filter((result) => result.verdict === verdict).length;
  console.log(
    `\nvisual: ${results.length} captures — ${count('same')} same, ${count('changed')} changed, ` +
      `${count('size-changed')} size-changed, ${count('new')} new, ${count('missing')} missing`,
  );
  for (const result of results) {
    if (result.verdict === 'same' && !result.problem) continue;
    const ratio = result.ratio === undefined ? '' : ` ${(result.ratio * 100).toFixed(3)}%`;
    const gate = result.gate ? ' [GATE]' : '';
    console.log(`  ${result.verdict.padEnd(12)} ${result.key}${ratio}${gate}`);
    if (result.problem) console.log(`    ✗ ${result.problem}`);
  }
  const candidates = results.filter(
    (result) => !result.gate && result.streak >= promotionStreak,
  ).length;
  if (candidates > 0) {
    console.log(
      `  ${candidates} review-only captures have matched ${promotionStreak}+ runs running`,
    );
  }
  if (accepted) console.log('  accepted: this run is now the baseline');
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

function reportHtml(
  report: { runId: string; profile: string; accepted: boolean; results: CaptureResult[] },
  promotionStreak: number,
): string {
  const order: Verdict[] = ['missing', 'size-changed', 'changed', 'new', 'same'];
  const rows = [...report.results]
    .sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict))
    .map((result) => {
      const image = (dir: string) =>
        `<a href="${dir}/${result.key}.png"><img src="${dir}/${result.key}.png" loading="lazy"></a>`;
      const cells =
        result.verdict === 'changed'
          ? [image('baseline'), image('captures'), image('diff')]
          : result.verdict === 'missing'
            ? ['', '', '']
            : ['', image('captures'), ''];
      const ratio = result.ratio === undefined ? '' : `${(result.ratio * 100).toFixed(3)}%`;
      const streak =
        result.streak >= promotionStreak && !result.gate
          ? `${result.streak} ★`
          : `${result.streak}`;
      return `<tr class="${result.verdict}">
  <th>${escapeHtml(result.key)}${result.gate ? ' <b>GATE</b>' : ''}<br><small>${result.verdict} ${ratio} · streak ${streak}</small>${
    result.problem ? `<br><em>${escapeHtml(result.problem)}</em>` : ''
  }</th>
  <td>${cells[0]}</td><td>${cells[1]}</td><td>${cells[2]}</td>
</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<title>visual ${escapeHtml(report.profile)} ${escapeHtml(report.runId)}</title>
<style>
  body { font: 13px system-ui; margin: 16px; }
  table { border-collapse: collapse; }
  th, td { border-top: 1px solid #ddd; padding: 8px; vertical-align: top; text-align: left; }
  img { max-width: 260px; max-height: 420px; border: 1px solid #ccc; }
  tr.changed th, tr.size-changed th, tr.missing th { color: #b00; }
  tr.new th { color: #06c; }
  em { color: #b00; }
</style>
<h1>${escapeHtml(report.profile)} — ${escapeHtml(report.runId)}</h1>
<p>Review-only unless marked GATE. ★ = matched its baseline ${promotionStreak}+ runs running.
${report.accepted ? '<b>Accepted as the new baseline.</b>' : ''}</p>
<table>
<tr><th></th><th>baseline</th><th>this run</th><th>diff</th></tr>
${rows}
</table>
`;
}
