import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { E2E_ROOT } from '../paths';
import { E2E_BROWSERS, type E2EBrowser } from './browser';
import { type E2EEnvironment } from './environment';
import { validateVisualCatalog } from './visual-catalog';

export type E2ESurface = 'web' | 'extension' | 'pwa' | 'native' | 'contract';
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
  // Omitted entries are local-only. Staging admission is reviewed per case.
  environments?: E2EEnvironment[];
  // The engines a WEB case runs on; omitted means Chrome only. Independent of
  // `environments`: a case listing both browsers and both tiers runs in all four
  // combinations. Firefox admission is reviewed per case, like staging, and is
  // kept to the cases whose outcome rests on something Gecko does its own way
  // (docs/e2e.md, _firefox_).
  browsers?: E2EBrowser[];
  // Server state the runner writes for this case on STAGING, outside the app.
  // `plan` is the only one there is: the `manual` purchase row (seed/plan.ts),
  // written to staging's remote D1 with a Cloudflare credential. Declared here
  // so the runner can prove that credential before any account is created, and
  // so the cases that need one are a list rather than a discovery — an
  // undeclared grant is refused at the write (seed/d1.ts). A local grant needs
  // no credential and is not declared. Only the surfaces in PLAN_GRANT_SURFACES
  // may declare it.
  stagingGrants?: 'plan'[];
}

// The runners that carry the plan credential's preflight (`proveStagingPlanAccess`)
// and mark their Playwright child: runner/web.ts and runner/extension.ts. ⚠ Adding
// a surface here admits a third runner to staging's D1, and passes every check
// there is unless that runner carries the same preflight (docs/e2e.md, _deployed
// staging and mobile Release builds_).
const PLAN_GRANT_SURFACES: E2ESurface[] = ['web', 'extension'];

export interface CaseFilters {
  suite?: E2ETier;
  cases?: string[];
  includeTraits?: string[];
  excludeTraits?: string[];
  // Select the `baseline` cases, and only them. They photograph checkpoints for
  // runner/visual.ts to compare with an accepted baseline, so no other runner
  // may pick one up: run by e2e-web or e2e-mobile they would capture into a run
  // nothing reviews. (`visual` alone is a trait of functional cases that make a
  // pixel claim — SKELETON-*, VIEWPORT-* — and selects nothing special.)
  baseline?: boolean;
  environment?: E2EEnvironment;
  browser?: E2EBrowser;
  // Start at this case: applied LAST, to what every other filter left, so the
  // id is one of the cases the run would have reached (runner/cli.ts, `from`).
  from?: string;
}

const REGISTRY_PATH = join(E2E_ROOT, 'cases.json');
const FIXTURE_REGISTRY_PATH = join(E2E_ROOT, 'fixtures.json');
// The prefix names the claim, not the surface: a case such as ACCOUNT-DELETE-001
// is filed under the journey it proves, and `surface` says where it runs. A
// single-word claim (FILTER-001, SEARCH-001, BULK-001) is as legal as a compound one.
const CASE_ID = /^[A-Z]+(?:-[A-Z]+)*-\d{3}$/;

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
    if (new URL(fixture.url).protocol !== 'https:' || fixture.trait !== 'internet') {
      throw new Error(`online extraction fixture ${fixture.id} must be https and tagged internet`);
    }
  }

  // Unique per SURFACE, not globally. A claim such as LINK-CLOSE-001 is one
  // journey proven on web and on native, and keeping its one id on both entries
  // is what lets a report line the two results up; every runner selects within
  // its own surface, so the pair can never be picked up by the same invocation.
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (
      testCase.environments &&
      (testCase.environments.length === 0 ||
        new Set(testCase.environments).size !== testCase.environments.length ||
        testCase.environments.some((value) => !['local', 'staging'].includes(value)) ||
        (testCase.tier === 'release' && testCase.environments.includes('staging')))
    ) {
      throw new Error(`${testCase.id}: invalid automated environments`);
    }
    if (
      testCase.browsers &&
      (testCase.browsers.length === 0 ||
        new Set(testCase.browsers).size !== testCase.browsers.length ||
        testCase.browsers.some((value) => !E2E_BROWSERS.includes(value)) ||
        // Only the web runner switches engines. The browser extension is a
        // Chromium build, the PWA target installs through Chromium's CDP, and
        // native has no browser of its own to choose.
        testCase.surface !== 'web' ||
        testCase.tier === 'release')
    ) {
      throw new Error(`${testCase.id}: invalid browsers (an automated web case only)`);
    }
    if (
      testCase.stagingGrants &&
      (testCase.stagingGrants.length !== 1 ||
        testCase.stagingGrants[0] !== 'plan' ||
        !PLAN_GRANT_SURFACES.includes(testCase.surface) ||
        !testCase.environments?.includes('staging'))
    ) {
      throw new Error(
        `${testCase.id}: stagingGrants is ["plan"], on a staging-admitted ` +
          `${PLAN_GRANT_SURFACES.join(' or ')} case`,
      );
    }
    if (!CASE_ID.test(testCase.id)) throw new Error(`invalid E2E case id: ${testCase.id}`);
    const key = `${testCase.surface}:${testCase.id}`;
    if (ids.has(key)) throw new Error(`duplicate E2E case id: ${key}`);
    ids.add(key);
    if (!['web', 'extension', 'pwa', 'native', 'contract'].includes(testCase.surface)) {
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
      const needle = ['web', 'extension', 'pwa'].includes(testCase.surface) ? `@${tag}` : tag;
      if (!source.includes(needle)) {
        throw new Error(`${testCase.id}: ${testCase.path} is missing registry tag ${needle}`);
      }
    }
  }

  validateVisualCatalog(cases);
}

export function selectCases(surface: E2ESurface, filters: CaseFilters = {}): E2ECase[] {
  const include = new Set(filters.includeTraits ?? []);
  const exclude = new Set(filters.excludeTraits ?? []);
  const requestedCases = new Set(filters.cases ?? []);
  const all = readCaseRegistry();
  const environment = filters.environment ?? 'local';
  const browser = filters.browser ?? 'chrome';

  for (const id of requestedCases) {
    const requested = all.find((testCase) => testCase.id === id && testCase.surface === surface);
    if (!requested) {
      throw new Error(`unknown ${surface} E2E case: ${id}`);
    }
    if (requested.tier === 'release') {
      throw new Error(`${id} is release qualification and cannot run automatically`);
    }
    if (!(requested.environments ?? ['local']).includes(environment)) {
      throw new Error(
        `${id} does not support ${environment}; its required fixtures are local-only`,
      );
    }
    if (!(requested.browsers ?? ['chrome']).includes(browser)) {
      throw new Error(`${id} does not run on ${browser}; its registry entry does not list it`);
    }
    if (requested.traits.includes('baseline') !== Boolean(filters.baseline)) {
      throw new Error(
        filters.baseline
          ? `${id} is not a visual checkpoint case`
          : `${id} is a visual checkpoint case; run it with e2e-visual`,
      );
    }
  }

  const selected = all.filter((testCase) => {
    if (testCase.surface !== surface) return false;
    if (!(testCase.environments ?? ['local']).includes(environment)) return false;
    if (!(testCase.browsers ?? ['chrome']).includes(browser)) return false;
    if (testCase.tier === 'release') return false;
    if (testCase.traits.includes('baseline') !== Boolean(filters.baseline)) return false;
    if (requestedCases.size > 0 && !requestedCases.has(testCase.id)) return false;
    if (filters.suite === 'smoke' && testCase.tier !== 'smoke') return false;
    if ([...include].some((trait) => !testCase.traits.includes(trait))) return false;
    if ([...exclude].some((trait) => testCase.traits.includes(trait))) return false;
    return true;
  });

  if (selected.length === 0) throw new Error(`no ${surface} E2E cases match the requested filters`);
  return startingFrom(selected, filters.from);
}

// Refuses an id the selection does not hold rather than running everything: a
// mistyped `--from` would otherwise repeat the very cases it was meant to skip.
function startingFrom(selected: E2ECase[], from: string | undefined): E2ECase[] {
  if (from === undefined) return selected;
  const index = selected.findIndex((testCase) => testCase.id === from);
  if (index === -1) {
    throw new Error(
      `--from ${from} is not one of the ${selected.length} selected cases: ` +
        'the id is unknown here, or another filter leaves it out',
    );
  }
  return selected.slice(index);
}

export function selectCasesForPlatform(
  surface: 'native' | 'contract',
  platform: 'ios' | 'android',
  filters: CaseFilters = {},
): E2ECase[] {
  // `from` waits for the platform filter: its case has to support the platform.
  const selected = selectCases(surface, { ...filters, from: undefined });
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
  return startingFrom(supported, filters.from);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

// The per-surface counts are printed here, not written into docs: a number
// typed into e2e/NEXT.md went stale on the first case added after it.
if (isMain()) {
  validateCaseRegistry();
  const cases = readCaseRegistry();
  const bySurface = new Map<E2ESurface, number>();
  for (const testCase of cases) {
    bySurface.set(testCase.surface, (bySurface.get(testCase.surface) ?? 0) + 1);
  }
  const counts = [...bySurface].map(([surface, n]) => `${surface} ${n}`).join(', ');
  console.log(`E2E case registry: ${cases.length} cases OK (${counts})`);
}
