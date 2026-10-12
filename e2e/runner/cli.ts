import { IS_STAGING } from './environment';
import { type E2ETier } from './registry';

export type NativePlatform = 'ios' | 'android';

export interface CommonFilters {
  suite: E2ETier;
  cases: string[];
  includeTraits: string[];
  excludeTraits: string[];
}

export interface NativeCliOptions extends CommonFilters {
  platform: NativePlatform;
  // Optional: the run takes the one booted device (runner/device.ts).
  deviceId?: string;
  releaseReceipt?: string;
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

export function parseNativeCli(argv = process.argv.slice(2)): NativeCliOptions {
  const parsed = parseArguments(
    argv,
    new Set([...FILTER_FLAGS, 'platform', 'device', 'release-receipt']),
  );
  if (parsed.passthrough.length > 0) {
    throw new Error(`unknown native E2E arguments: ${parsed.passthrough.join(' ')}`);
  }

  const platform = one(parsed.values, 'platform');
  if (!platform) {
    throw new Error(
      '--platform is required: ios or android. The root scripts carry it — ' +
        (IS_STAGING
          ? '`npm run e2e:mobile:staging:ios`, `e2e:mobile:staging:android`, ' +
            '`e2e:contract:staging:ios`, `e2e:contract:staging:android`.'
          : '`npm run e2e:mobile:ios`, `e2e:mobile:android`, ' +
            '`e2e:contract:ios`, `e2e:contract:android`.'),
    );
  }
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`--platform must be "ios" or "android", got ${platform}`);
  }

  // Optional in staging too: the newest build's receipt (release-artifact.ts).
  const releaseReceipt = one(parsed.values, 'release-receipt');
  if (!IS_STAGING && releaseReceipt) throw new Error('--release-receipt requires staging mode');
  return {
    ...filters(parsed.values),
    platform,
    deviceId: one(parsed.values, 'device'),
    releaseReceipt,
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
  // booted device (runner/device.ts).
  deviceId?: string;
  // Make this run's captures the baseline, once it has passed.
  accept: boolean;
}

export function parseVisualCli(argv = process.argv.slice(2)): VisualCliOptions {
  const accept = argv.includes('--accept');
  const parsed = parseArguments(
    argv.filter((argument) => argument !== '--accept'),
    new Set([...FILTER_FLAGS, 'platform', 'device']),
  );
  if (parsed.passthrough.length > 0) {
    throw new Error(`unknown visual E2E arguments: ${parsed.passthrough.join(' ')}`);
  }
  const platform = one(parsed.values, 'platform');
  if (!platform) {
    throw new Error(
      '--platform is required: web, ios or android. The root scripts carry it — ' +
        '`npm run e2e:visual:web`, `e2e:visual:ios`, `e2e:visual:android`.',
    );
  }
  if (platform !== 'web' && platform !== 'ios' && platform !== 'android') {
    throw new Error(`--platform must be "web", "ios" or "android", got ${platform}`);
  }
  const deviceId = one(parsed.values, 'device');
  if (platform === 'web' && deviceId) throw new Error('--device is for ios and android only');
  return { ...filters(parsed.values), platform, deviceId, accept };
}
