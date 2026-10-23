import { IS_STAGING } from './environment';
import { type E2ETier } from './registry';
import { E2E_WIDTHS, type E2EWidth } from './width';

export type NativePlatform = 'ios' | 'android';

export interface CommonFilters {
  suite: E2ETier;
  cases: string[];
  includeTraits: string[];
  excludeTraits: string[];
}

export interface NativeCliOptions extends CommonFilters {
  platform: NativePlatform;
  // Optional: the run takes the one booted device of its width (runner/device.ts).
  deviceId?: string;
  // The window width the run is made at (runner/width.ts): which cases it
  // selects, and which device it takes. `narrow` unless the script says `wide`.
  width: E2EWidth;
  releaseReceipt?: string;
  // `--from <case-id>`: drop every selected case ahead of this one, to pick a
  // run back up at the case that failed. Native only — these runners take the
  // selection one case at a time, in registry order, so "ahead of" is the order
  // the run would have had. Playwright orders and parallelises its own, so the
  // web wrappers leave the flag a passthrough and Playwright refuses it by name.
  from?: string;
}

interface ParsedArguments {
  values: Map<string, string[]>;
  passthrough: string[];
}

function parseArguments(argv: string[], known: Set<string>): ParsedArguments {
  const values = new Map<string, string[]>();
  const passthrough: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      passthrough.push(argument);
      continue;
    }

    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    if (!known.has(name)) {
      passthrough.push(argument);
      continue;
    }

    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (equals === -1) index += 1;
    values.set(name, [...(values.get(name) ?? []), value]);
  }

  return { values, passthrough };
}

function one(values: Map<string, string[]>, name: string, required = false): string | undefined {
  const found = values.get(name) ?? [];
  if (found.length > 1) throw new Error(`--${name} may only be provided once`);
  if (required && !found[0]) throw new Error(`--${name} is required`);
  return found[0];
}

function commaList(values: Map<string, string[]>, name: string): string[] {
  return (values.get(name) ?? [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function filters(values: Map<string, string[]>): CommonFilters {
  const suite = one(values, 'suite') ?? 'full';
  if (suite !== 'smoke' && suite !== 'full') {
    throw new Error(`--suite must be "smoke" or "full", got ${suite}`);
  }
  return {
    suite,
    cases: commaList(values, 'case'),
    includeTraits: commaList(values, 'include-trait'),
    excludeTraits: commaList(values, 'exclude-trait'),
  };
}

const FILTER_FLAGS = new Set(['suite', 'case', 'include-trait', 'exclude-trait']);

function width(values: Map<string, string[]>): E2EWidth {
  const value = one(values, 'width') ?? 'narrow';
  if (!E2E_WIDTHS.includes(value as E2EWidth)) {
    throw new Error(`--width must be "narrow" or "wide", got ${value}`);
  }
  return value as E2EWidth;
}

export function parseNativeCli(argv = process.argv.slice(2)): NativeCliOptions {
  const parsed = parseArguments(
    argv,
    new Set([...FILTER_FLAGS, 'platform', 'device', 'width', 'release-receipt', 'from']),
  );
  if (parsed.passthrough.length > 0) {
    throw new Error(`unknown native E2E arguments: ${parsed.passthrough.join(' ')}`);
  }

  const platform = one(parsed.values, 'platform');
  if (!platform) {
    throw new Error(
      '--platform is required: ios or android. The root scripts carry it — ' +
        (IS_STAGING
          ? '`npm run e2e:ios:iphone:staging`, `e2e:android:phone:staging`, ' +
            '`e2e:contract:ios:staging`, `e2e:contract:android:staging`.'
          : '`npm run e2e:ios:iphone`, `e2e:ios:ipad`, `e2e:android:phone`, ' +
            '`e2e:android:tablet`, `e2e:contract:ios`, `e2e:contract:android`.'),
    );
  }
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`--platform must be "ios" or "android", got ${platform}`);
  }

  // Optional in staging too: the newest build's receipt (release-artifact.ts).
  const releaseReceipt = one(parsed.values, 'release-receipt');
  if (!IS_STAGING && releaseReceipt) throw new Error('--release-receipt requires staging mode');
  // Staging proves the deployed services, which never see the window, so it is
  // made on the phone alone (docs/e2e.md, _narrow and wide_).
  const runWidth = width(parsed.values);
  if (IS_STAGING && runWidth === 'wide') {
    throw new Error(
      'staging runs on a phone only; a wide run is local (docs/e2e.md, _narrow and wide_)',
    );
  }
  return {
    ...filters(parsed.values),
    platform,
    deviceId: one(parsed.values, 'device'),
    width: runWidth,
    releaseReceipt,
    from: one(parsed.values, 'from'),
  };
}

export interface WebCliOptions extends CommonFilters {
  playwrightArgs: string[];
  // `--slow-mo <ms>`: how long each browser operation is held back, for
  // watching a `--headed` run. Playwright has no such flag, so it is the
  // wrapper's — and only where `watch` is set (runner/web.ts). Anywhere else it
  // stays a passthrough and Playwright refuses it by name.
  slowMo?: number;
}

export function parseWebCli(argv = process.argv.slice(2), watch = false): WebCliOptions {
  const parsed = parseArguments(argv, watch ? new Set([...FILTER_FLAGS, 'slow-mo']) : FILTER_FLAGS);
  // The last one wins, so a value after `--` overrides the root script's.
  const slowMo = parsed.values.get('slow-mo')?.at(-1);
  if (slowMo !== undefined && !/^\d+$/.test(slowMo)) {
    throw new Error(`--slow-mo takes whole milliseconds, got ${slowMo}`);
  }
  return {
    ...filters(parsed.values),
    playwrightArgs: parsed.passthrough,
    slowMo: slowMo === undefined ? undefined : Number(slowMo),
  };
}

export interface VisualCliOptions extends CommonFilters {
  platform: 'web' | NativePlatform;
  // The web leg drives the local browser; a native one defaults to the one
  // booted device of its width (runner/device.ts).
  deviceId?: string;
  // Native only. Web takes both of its layouts in every run, as two Playwright
  // projects (visual.playwright.config.ts); a device has the one it has.
  width: E2EWidth;
  // Make this run's captures the baseline, once it has passed.
  accept: boolean;
}

export function parseVisualCli(argv = process.argv.slice(2)): VisualCliOptions {
  const accept = argv.includes('--accept');
  const parsed = parseArguments(
    argv.filter((argument) => argument !== '--accept'),
    new Set([...FILTER_FLAGS, 'platform', 'device', 'width']),
  );
  if (parsed.passthrough.length > 0) {
    throw new Error(`unknown visual E2E arguments: ${parsed.passthrough.join(' ')}`);
  }
  const platform = one(parsed.values, 'platform');
  if (!platform) {
    throw new Error(
      '--platform is required: web, ios or android. The root scripts carry it — ' +
        '`npm run e2e:visual:web`, `e2e:visual:ios:iphone`, `e2e:visual:ios:ipad`, ' +
        '`e2e:visual:android:phone`, `e2e:visual:android:tablet`.',
    );
  }
  if (platform !== 'web' && platform !== 'ios' && platform !== 'android') {
    throw new Error(`--platform must be "web", "ios" or "android", got ${platform}`);
  }
  const deviceId = one(parsed.values, 'device');
  if (platform === 'web' && deviceId) throw new Error('--device is for ios and android only');
  if (platform === 'web' && parsed.values.has('width')) {
    throw new Error('--width is for ios and android only; web takes wide and narrow in every run');
  }
  return { ...filters(parsed.values), platform, deviceId, width: width(parsed.values), accept };
}
