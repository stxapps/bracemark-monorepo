import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { type NativePlatform } from './cli';
import { capture } from './process';

function assertSafeFileName(fileName: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(fileName)) {
    throw new Error(`unsafe document-picker fixture name: ${fileName}`);
  }
}

// Put one generated fixture where the platform's REAL document picker can read
// it. No app storage or picker API is mocked: Android reads Downloads, while the
// iOS simulator reads the Files app's Local Storage provider. The latter path is
// resolved from simctl every run rather than hard-coding a simulator UUID.
export async function stageDocumentPickerFile(options: {
  platform: NativePlatform;
  deviceId: string;
  sourcePath: string;
  fileName: string;
}): Promise<() => Promise<void>> {
  assertSafeFileName(options.fileName);

  if (options.platform === 'android') {
    const target = `/sdcard/Download/${options.fileName}`;
    await capture('adb', ['-s', options.deviceId, 'push', options.sourcePath, target]);
    return async () => {
      await capture('adb', ['-s', options.deviceId, 'shell', 'rm', '-f', target], {
        allowFailure: true,
      });
    };
  }

  const groups = await capture('xcrun', [
    'simctl',
    'get_app_container',
    options.deviceId,
    'com.apple.DocumentsApp',
    'groups',
  ]);
  const localStorageLine = groups.stdout
    .split('\n')
    .find((line) => line.startsWith('group.com.apple.FileProvider.LocalStorage\t'));
  const groupPath = localStorageLine?.split('\t').slice(1).join('\t').trim();
  if (!groupPath) {
    throw new Error('the iOS simulator has no Files Local Storage group container');
  }
  const storage = join(groupPath, 'File Provider Storage');
  const target = join(storage, options.fileName);
  await mkdir(storage, { recursive: true });
  await copyFile(options.sourcePath, target);
  return async () => {
    await unlink(target).catch(() => undefined);
  };
}
