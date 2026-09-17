import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT, runArtifactDir } from '../paths';
import { API_URL, EXTRACTOR_URL, WEB_URL } from '../web/fixtures/env';
import { type NativeCliOptions, type NativePlatform } from './cli';
import {
  createRunId,
  maestro,
  maestroCommand,
  maestroHierarchy,
  type MaestroOptions,
  waitForApi,
  waitForHttp,
  writeJson,
} from './lib';
import { capture } from './process';
import { type E2ECase } from './registry';
import { assertOriginOwnedByRepo, assertStackOwnedByRepo } from './stack';

const APP_ID = 'com.bracemark.app';
const REPO_ROOT = join(E2E_ROOT, '..');
// Twin of the fallback in mobile/flows/subflows/cold-launch.yaml; keep them in step.
const DEFAULT_DEV_CLIENT_LINK =
  'bracemark://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081%2F%3FdisableOnboarding%3D1';

interface DeviceIdentity {
  id: string;
  name: string;
  model: string;
  osVersion: string;
}

interface AppIdentity {
  appId: string;
  version?: string;
  build?: string;
  installPath: string;
}

interface CaseResult {
  id: string;
  path: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}

interface RunManifest {
  schemaVersion: 1;
  runId: string;
  kind: 'mobile' | 'contract';
  status: 'running' | 'passed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  platform: NativePlatform;
  device: DeviceIdentity;
  maestroVersion: string;
  app: AppIdentity;
  suite: string;
  filters: {
    cases: string[];
    includeTraits: string[];
    excludeTraits: string[];
  };
  devClientLink: string;
  origins: { web: string; api: string; extractor: string; metro: string };
  checkout: { root: string; commit: string; dirty: boolean };
  cases: CaseResult[];
}

export interface NativeRun {
  runId: string;
  runDir: string;
  platform: NativePlatform;
  deviceId: string;
  devClientLink: string;
  runCase(testCase: E2ECase, env?: Record<string, string>, secretValues?: string[]): Promise<void>;
  finish(status: 'passed' | 'failed'): Promise<void>;
}

function metroOrigin(devClientLink: string): string {
  const outer = new URL(devClientLink);
  if (outer.protocol !== 'bracemark:') {
    throw new Error(`EXPO_DEV_CLIENT_LINK must use bracemark:, got ${outer.protocol}`);
  }
  if (outer.hostname !== 'expo-development-client') {
    throw new Error('EXPO_DEV_CLIENT_LINK must target expo-development-client');
  }
  const innerValue = outer.searchParams.get('url');
  if (!innerValue) throw new Error('EXPO_DEV_CLIENT_LINK is missing its inner url');
  const inner = new URL(innerValue);
  if (inner.searchParams.get('disableOnboarding') !== '1') {
    throw new Error('EXPO_DEV_CLIENT_LINK must set disableOnboarding=1 on its inner url');
  }
  return inner.origin;
}

async function probeMetro(origin: string): Promise<void> {
  await assertOriginOwnedByRepo(origin, 'Metro', { required: true });
  const response = await fetch(`${origin}/status`);
  const body = await response.text();
  if (!response.ok || !body.includes('packager-status:running')) {
    throw new Error(`Metro at ${origin} did not report packager-status:running`);
  }
}

async function iosDevice(deviceId: string): Promise<{ device: DeviceIdentity; app: AppIdentity }> {
  const result = await capture('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  const parsed = JSON.parse(result.stdout) as {
    devices: Record<
      string,
      Array<{ udid: string; name: string; state: string; deviceTypeIdentifier: string }>
    >;
  };
  const match = Object.entries(parsed.devices)
    .flatMap(([runtime, devices]) => devices.map((device) => ({ runtime, ...device })))
    .find((device) => device.udid === deviceId);
  if (!match) throw new Error(`iOS device ${deviceId} is not booted`);
  if (match.state !== 'Booted')
    throw new Error(`iOS device ${deviceId} is ${match.state}, not Booted`);

  const container = (
    await capture('xcrun', ['simctl', 'get_app_container', deviceId, APP_ID, 'app'])
  ).stdout.trim();
  const info = join(container, 'Info.plist');
  const [version, build] = await Promise.all([
    capture('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', info], {
      allowFailure: true,
    }),
    capture('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', info], {
      allowFailure: true,
    }),
  ]);

  return {
    device: {
      id: deviceId,
      name: match.name,
      model: match.deviceTypeIdentifier.replace('com.apple.CoreSimulator.SimDeviceType.', ''),
      osVersion: match.runtime
        .replace('com.apple.CoreSimulator.SimRuntime.iOS-', '')
        .replaceAll('-', '.'),
    },
    app: {
      appId: APP_ID,
      version: version.stdout.trim() || undefined,
      build: build.stdout.trim() || undefined,
      installPath: container,
    },
  };
}

async function androidValue(deviceId: string, args: string[]): Promise<string> {
  return (await capture('adb', ['-s', deviceId, ...args])).stdout.trim();
}

async function androidDevice(
  deviceId: string,
  requiredReversePorts: number[],
): Promise<{ device: DeviceIdentity; app: AppIdentity }> {
  const devices = await capture('adb', ['devices', '-l']);
  const line = devices.stdout
    .split('\n')
    .find((candidate) => candidate.trim().split(/\s+/)[0] === deviceId);
  if (!line) throw new Error(`Android device ${deviceId} is not attached`);
  if (line.trim().split(/\s+/)[1] !== 'device')
    throw new Error(`Android device ${deviceId} is not ready: ${line}`);

  const booted = await androidValue(deviceId, ['shell', 'getprop', 'sys.boot_completed']);
  if (booted !== '1') throw new Error(`Android device ${deviceId} has not completed boot`);

  const reversals = await androidValue(deviceId, ['reverse', '--list']);
  for (const port of requiredReversePorts) {
    if (!reversals.includes(`tcp:${port} tcp:${port}`)) {
      throw new Error(
        `Android device ${deviceId} is missing tcp:${port} reverse mapping. ` +
          'Run `npm run expo:android:reverse` and retry.',
      );
    }
  }

  const installPath = await androidValue(deviceId, ['shell', 'pm', 'path', APP_ID]);
  if (!installPath.startsWith('package:')) {
    throw new Error(`${APP_ID} is not installed on Android device ${deviceId}`);
  }
  const [name, model, osVersion, packageDump] = await Promise.all([
    androidValue(deviceId, ['shell', 'getprop', 'ro.product.device']),
    androidValue(deviceId, ['shell', 'getprop', 'ro.product.model']),
    androidValue(deviceId, ['shell', 'getprop', 'ro.build.version.release']),
    androidValue(deviceId, ['shell', 'dumpsys', 'package', APP_ID]),
  ]);

  return {
    device: { id: deviceId, name, model, osVersion },
    app: {
      appId: APP_ID,
      version: packageDump.match(/versionName=([^\s]+)/)?.[1],
      build: packageDump.match(/versionCode=(\d+)/)?.[1],
      installPath: installPath.replace(/^package:/, ''),
    },
  };
}

async function redactTextArtifacts(root: string, secrets: string[]): Promise<void> {
  const values = [...new Set(secrets.filter(Boolean))];
  if (values.length === 0) return;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await redactTextArtifacts(path, values);
      continue;
    }
    if (!/\.(?:html|json|log|txt|xml|ya?ml)$/i.test(entry.name)) continue;
    const original = await readFile(path, 'utf8');
    const redacted = values.reduce(
      (text, secret) => text.replaceAll(secret, '[REDACTED]'),
      original,
    );
    if (redacted !== original) await writeFile(path, redacted, 'utf8');
  }
}

async function removeSensitiveScreenshots(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await removeSensitiveScreenshots(path);
      continue;
    }
    // The recovery field is intentionally readable user input. Maestro may take
    // diagnostic screenshots while it is on screen, so discard every automatic
    // raster from that case. The named final checkpoint is under takeScreenshot/
    // after the form has unmounted and is safe to retain.
    if (/\.(?:jpe?g|png)$/i.test(entry.name) && !path.includes('/takeScreenshot/')) {
      await unlink(path);
    }
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function prepareNativeRun(
  kind: 'mobile' | 'contract',
  options: NativeCliOptions,
  selectedCases: E2ECase[],
): Promise<NativeRun> {
  const runId = createRunId(`${kind}-${options.platform}`);
  process.env.E2E_RUN_ID = runId;
  const runDir = runArtifactDir(runId);
  await mkdir(runDir, { recursive: true });

  const devClientLink = process.env.EXPO_DEV_CLIENT_LINK ?? DEFAULT_DEV_CLIENT_LINK;
  const metro = metroOrigin(devClientLink);
  const requiresOnlineStack = selectedCases.some((testCase) => testCase.traits.includes('online'));
  if (requiresOnlineStack) {
    await waitForApi();
    await assertStackOwnedByRepo([
      { origin: WEB_URL, label: 'bracemark-web', required: true },
      { origin: API_URL, label: 'bracemark-api', required: true },
      { origin: EXTRACTOR_URL, label: 'bracemark-extractor', required: true },
    ]);
    await waitForHttp(new URL('/create-account', WEB_URL).href, 'bracemark-web', 30_000);
  }
  await probeMetro(metro);

  const identity =
    options.platform === 'ios'
      ? await iosDevice(options.deviceId)
      : await androidDevice(options.deviceId, requiresOnlineStack ? [8081, 8787, 8788] : [8081]);
  const maestroVersion = (
    await capture(join(process.env.HOME ?? '', '.maestro/bin/maestro'), ['--version'])
  ).stdout.trim();
  const [commit, status] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }),
    capture('git', ['status', '--porcelain'], { cwd: REPO_ROOT }),
  ]);

  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    kind,
    status: 'running',
    startedAt: new Date().toISOString(),
    platform: options.platform,
    device: identity.device,
    maestroVersion,
    app: identity.app,
    suite: options.suite,
    filters: {
      cases: options.cases,
      includeTraits: options.includeTraits,
      excludeTraits: options.excludeTraits,
    },
    devClientLink,
    origins: { web: WEB_URL, api: API_URL, extractor: EXTRACTOR_URL, metro },
    checkout: {
      root: REPO_ROOT,
      commit: commit.stdout.trim(),
      dirty: status.stdout.trim().length > 0,
    },
    cases: selectedCases.map((testCase) => ({
      id: testCase.id,
      path: testCase.path,
      status: 'pending',
    })),
  };
  const manifestPath = join(runDir, 'run.json');
  await writeJson(manifestPath, manifest);

  return {
    runId,
    runDir,
    platform: options.platform,
    deviceId: options.deviceId,
    devClientLink,
    async runCase(testCase, env = {}, secretValues = []) {
      const result = manifest.cases.find((candidate) => candidate.id === testCase.id);
      if (!result) throw new Error(`${testCase.id} was not selected for this run`);
      const started = Date.now();
      result.status = 'running';
      result.startedAt = new Date(started).toISOString();
      await writeJson(manifestPath, manifest);

      const caseDir = join(runDir, 'cases', testCase.id);
      const maestroOptions: MaestroOptions = {
        platform: options.platform,
        deviceId: options.deviceId,
        env: { EXPO_DEV_CLIENT_LINK: devClientLink, ...env },
        reportPath: join(caseDir, 'junit.xml'),
        testOutputDir: join(caseDir, 'maestro'),
        debugOutputDir: join(caseDir, 'debug'),
        includeTags: [testCase.tier, ...options.includeTraits],
        excludeTags: options.excludeTraits,
      };
      const command = maestroCommand(testCase.path, maestroOptions);
      await writeJson(join(caseDir, 'command.json'), {
        command: command.command,
        args: command.args.map((argument) =>
          argument.includes('=') &&
          command.environmentKeys.includes(argument.slice(0, argument.indexOf('=')))
            ? `${argument.slice(0, argument.indexOf('='))}=[REDACTED]`
            : argument,
        ),
        environmentKeys: command.environmentKeys,
      });

      try {
        await maestro(testCase.path, maestroOptions);
        result.status = 'passed';
      } catch (error) {
        result.status = 'failed';
        result.error = safeError(error);
        try {
          const hierarchy = await maestroHierarchy({
            platform: options.platform,
            deviceId: options.deviceId,
          });
          await writeFile(join(caseDir, 'hierarchy.txt'), hierarchy, 'utf8');
        } catch (hierarchyError) {
          await writeFile(
            join(caseDir, 'hierarchy-error.txt'),
            `${safeError(hierarchyError)}\n`,
            'utf8',
          );
        }
        throw error;
      } finally {
        result.finishedAt = new Date().toISOString();
        result.durationMs = Date.now() - started;
        await redactTextArtifacts(caseDir, secretValues);
        if (testCase.id === 'NATIVE-ACCOUNT-002') {
          await removeSensitiveScreenshots(caseDir);
        }
        await writeJson(manifestPath, manifest);
      }
    },
    async finish(statusValue) {
      manifest.status = statusValue;
      manifest.finishedAt = new Date().toISOString();
      await writeJson(manifestPath, manifest);
      console.log(`native E2E artifacts: ${runDir}`);
    },
  };
}
