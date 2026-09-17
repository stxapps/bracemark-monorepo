import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { E2E_ROOT } from '../paths';

export type E2ESurface = 'web' | 'extension' | 'native' | 'contract';
export type E2ETier = 'smoke' | 'full' | 'release';
export type FixtureSize = 'empty' | 'small' | 'scale';

export interface E2ECase {
  id: string;
  title: string;
  surface: E2ESurface;
  tier: E2ETier;
  traits: string[];
  fixture: FixtureSize;
  path: string;
  artifacts: string[];
}

export interface CaseFilters {
  suite?: E2ETier;
  cases?: string[];
  includeTraits?: string[];
  excludeTraits?: string[];
}

const REGISTRY_PATH = join(E2E_ROOT, 'cases.json');
const FIXTURE_REGISTRY_PATH = join(E2E_ROOT, 'fixtures.json');
// The prefix names the claim, not the surface: a case such as ACCOUNT-DELETE-001
// is filed under the journey it proves, and `surface` says where it runs.
const CASE_ID = /^[A-Z]+(?:-[A-Z]+)+-\d{3}$/;

export function readCaseRegistry(): E2ECase[] {
  const parsed: unknown = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('e2e/cases.json must contain an array');
  return parsed as E2ECase[];
}

export function validateCaseRegistry(cases = readCaseRegistry()): void {
  const fixtures = JSON.parse(readFileSync(FIXTURE_REGISTRY_PATH, 'utf8')) as {
    sizes: Record<string, { generator?: string; importDriver?: string }>;
    urls: {
      deterministic: { suffix: string };
      onlineExtraction: Array<{ id: string; url: string; trait: string }>;
    };
  };
  if (fixtures.urls.deterministic.suffix !== '.invalid') {
    throw new Error('deterministic E2E URLs must reserve the .invalid suffix');
  }
  for (const field of ['generator', 'importDriver'] as const) {
    const path = fixtures.sizes.scale?.[field];
    if (!path || !existsSync(join(E2E_ROOT, path))) {
      throw new Error(`scale fixture is missing its ${field} path`);
    }
  }
  for (const fixture of fixtures.urls.onlineExtraction) {
    if (new URL(fixture.url).protocol !== 'https:' || fixture.trait !== 'online') {
      throw new Error(`online extraction fixture ${fixture.id} must be https and tagged online`);
    }
  }

  // Unique per SURFACE, not globally. A claim such as LINK-CLOSE-001 is one
  // journey proven on web and on native, and keeping its one id on both entries
  // is what lets a report line the two results up; every runner selects within
  // its own surface, so the pair can never be picked up by the same invocation.
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (!CASE_ID.test(testCase.id)) throw new Error(`invalid E2E case id: ${testCase.id}`);
    const key = `${testCase.surface}:${testCase.id}`;
    if (ids.has(key)) throw new Error(`duplicate E2E case id: ${key}`);
    ids.add(key);
    if (!['web', 'extension', 'native', 'contract'].includes(testCase.surface)) {
      throw new Error(`${testCase.id}: invalid surface ${testCase.surface}`);
    }
    if (!['smoke', 'full', 'release'].includes(testCase.tier)) {
      throw new Error(`${testCase.id}: invalid tier ${testCase.tier}`);
    }
    if (!(testCase.fixture in fixtures.sizes)) {
      throw new Error(`${testCase.id}: invalid fixture ${testCase.fixture}`);
    }
    if (!existsSync(join(E2E_ROOT, testCase.path))) {
      throw new Error(`${testCase.id}: missing path ${testCase.path}`);
    }
    const source = readFileSync(join(E2E_ROOT, testCase.path), 'utf8');
    const expectedTags = [testCase.id, testCase.tier, ...testCase.traits];
    for (const tag of expectedTags) {
      const needle = ['web', 'extension'].includes(testCase.surface) ? `@${tag}` : tag;
      if (!source.includes(needle)) {
        throw new Error(`${testCase.id}: ${testCase.path} is missing registry tag ${needle}`);
      }
    }
  }
}

export function selectCases(surface: E2ESurface, filters: CaseFilters = {}): E2ECase[] {
  const include = new Set(filters.includeTraits ?? []);
  const exclude = new Set(filters.excludeTraits ?? []);
  const requestedCases = new Set(filters.cases ?? []);
  const all = readCaseRegistry();

  for (const id of requestedCases) {
    const requested = all.find((testCase) => testCase.id === id && testCase.surface === surface);
    if (!requested) {
      throw new Error(`unknown ${surface} E2E case: ${id}`);
    }
    if (requested.tier === 'release') {
      throw new Error(`${id} is release qualification and cannot run automatically`);
    }
  }

  const selected = all.filter((testCase) => {
    if (testCase.surface !== surface) return false;
    if (testCase.tier === 'release') return false;
    if (requestedCases.size > 0 && !requestedCases.has(testCase.id)) return false;
    if (filters.suite === 'smoke' && testCase.tier !== 'smoke') return false;
    if ([...include].some((trait) => !testCase.traits.includes(trait))) return false;
    if ([...exclude].some((trait) => testCase.traits.includes(trait))) return false;
    return true;
  });

  if (selected.length === 0) throw new Error(`no ${surface} E2E cases match the requested filters`);
  return selected;
}

export function selectCasesForPlatform(
  surface: 'native' | 'contract',
  platform: 'ios' | 'android',
  filters: CaseFilters = {},
): E2ECase[] {
  const selected = selectCases(surface, filters);
  const requested = new Set(filters.cases ?? []);
  const supported = selected.filter((testCase) => testCase.traits.includes(platform));
  const incompatible = selected.filter(
    (testCase) => requested.has(testCase.id) && !testCase.traits.includes(platform),
  );
  if (incompatible.length > 0) {
    throw new Error(
      `${incompatible.map((testCase) => testCase.id).join(', ')} does not support ${platform}`,
    );
  }
  if (supported.length === 0) {
    throw new Error(`no ${surface} E2E cases support ${platform} with the requested filters`);
  }
  return supported;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isMain()) {
  validateCaseRegistry();
  console.log(`E2E case registry: ${readCaseRegistry().length} cases OK`);
}
