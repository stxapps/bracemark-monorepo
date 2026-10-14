import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { type BrowserContext, chromium, expect, type Page } from '@playwright/test';

import { E2E_ROOT } from '../../paths';
import { type Credentials } from '../../web/fixtures/account';

const REPO_ROOT = join(E2E_ROOT, '..');
const EXTENSION_PROJECT = '@stxapps/bracemark-extension';

// The two Chrome MV3 builds a run can drive, by WXT mode: `development` talks to
// the local api, `staging` is the bundle built for the deployed dryrunbase.com
// tier (`.env.staging`). Each output directory is its Nx target's declared output,
// so a cache hit restores it in place.
const BUILDS = {
  development: { target: 'build:development', output: 'chrome-mv3-dev' },
  staging: { target: 'build:staging', output: 'chrome-mv3-staging' },
} as const;

export type ExtensionBuildMode = keyof typeof BUILDS;

export const EXTENSION_POPUP_WIDTH = 360;

export interface StageExtensionOptions {
  // The build to copy; the development build unless named.
  source?: string;
  permissions?: string[];
  hostPermissions?: string[];
}

export function extensionBuildDir(mode: ExtensionBuildMode): string {
  return join(REPO_ROOT, 'apps', 'bracemark-extension', '.output', BUILDS[mode].output);
}

/** Build the real browser extension once, before staging run-specific copies. */
export function buildExtension(mode: ExtensionBuildMode): string {
  execFileSync('npx', ['nx', BUILDS[mode].target, EXTENSION_PROJECT], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  return extensionBuildDir(mode);
}

export function buildDevelopmentExtension(): void {
  buildExtension('development');
}

/**
 * Copy the build into run artifacts and add only the permissions the driver needs.
 * The source build and the store manifest are never changed.
 */
export async function stageExtensionCopy(
  target: string,
  options: StageExtensionOptions = {},
): Promise<string> {
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(options.source ?? extensionBuildDir('development'), target, { recursive: true });

  const manifestPath = join(target, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    permissions?: string[];
    host_permissions?: string[];
  };
  manifest.permissions = [
    ...new Set([...(manifest.permissions ?? []), ...(options.permissions ?? [])]),
  ];
  if (manifest.host_permissions || options.hostPermissions?.length) {
    manifest.host_permissions = [
      ...new Set([...(manifest.host_permissions ?? []), ...(options.hostPermissions ?? [])]),
    ];
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return target;
}

export interface LaunchExtensionOptions {
  resetProfile?: boolean;
  headless?: boolean;
  deviceScaleFactor?: number;
}

/** Launch an unpacked extension in Playwright's bundled Chromium. */
export async function launchExtensionProfile(
  userDataDir: string,
  extension: string,
  options: LaunchExtensionOptions = {},
): Promise<BrowserContext> {
  if (options.resetProfile !== false) await rm(userDataDir, { recursive: true, force: true });
  await mkdir(dirname(userDataDir), { recursive: true });

  return chromium.launchPersistentContext(userDataDir, {
    // This runtime does not register an unpacked MV3 worker in Playwright's
    // default headless mode. Headed Chromium is therefore part of the driver,
    // not a debugging preference; the shot leg already needs it for paint too.
    headless: options.headless ?? false,
    deviceScaleFactor: options.deviceScaleFactor ?? 2,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
}

/** The unpacked extension id is minted at load time and carried by its worker URL. */
export async function extensionId(context: BrowserContext): Promise<string> {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  return new URL(worker.url()).host;
}

/**
 * Mount popup.html as an attachable tab while keeping the subject tab active.
 * Reloading after the subject is focused makes SaveFlow query the intended page.
 */
export async function openExtensionPopup(
  context: BrowserContext,
  id: string,
  subject: Page,
  options: { height?: number } = {},
): Promise<Page> {
  const popup = await context.newPage();
  await popup.setViewportSize({
    width: EXTENSION_POPUP_WIDTH,
    height: options.height ?? 700,
  });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await subject.bringToFront();
  await popup.reload();
  return popup;
}

/** Sign in through the extension's own form and wait for its authenticated shell. */
export async function signInExtension(popup: Page, credentials: Credentials): Promise<void> {
  await popup.getByRole('textbox', { name: 'Username' }).fill(credentials.username);
  await popup.getByRole('textbox', { name: 'Password' }).fill(credentials.password);
  await popup.getByRole('button', { name: 'Sign in' }).click();
  await expect(popup.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 120_000 });
}

/** A resting synced pill is the product's own settled-state signal. */
export async function waitForExtensionSync(popup: Page): Promise<void> {
  await expect(popup.getByRole('button', { name: /^Synced/ })).toBeVisible({ timeout: 180_000 });
}
