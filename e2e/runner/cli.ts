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
  deviceId: string;
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
  const parsed = parseArguments(argv, new Set([...FILTER_FLAGS, 'platform', 'device']));
  if (parsed.passthrough.length > 0) {
    throw new Error(`unknown native E2E arguments: ${parsed.passthrough.join(' ')}`);
  }

  const platform = one(parsed.values, 'platform', true);
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(`--platform must be "ios" or "android", got ${platform}`);
  }

  return {
    ...filters(parsed.values),
    platform,
    deviceId: one(parsed.values, 'device', true) as string,
  };
}

export interface WebCliOptions extends CommonFilters {
  playwrightArgs: string[];
}

export function parseWebCli(argv = process.argv.slice(2)): WebCliOptions {
  const parsed = parseArguments(argv, FILTER_FLAGS);
  return { ...filters(parsed.values), playwrightArgs: parsed.passthrough };
}

export interface VisualCliOptions extends CommonFilters {
  platform: 'web' | NativePlatform;
  // Required on a device; the web leg drives the local browser.
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
  const platform = one(parsed.values, 'platform', true);
  if (platform !== 'web' && platform !== 'ios' && platform !== 'android') {
    throw new Error(`--platform must be "web", "ios" or "android", got ${platform}`);
  }
  const deviceId = one(parsed.values, 'device', platform !== 'web');
  if (platform === 'web' && deviceId) throw new Error('--device is for ios and android only');
  return { ...filters(parsed.values), platform, deviceId, accept };
}
