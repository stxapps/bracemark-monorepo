// The App Group id is stated twice and must be one id: app.config.ts's
// `ios.entitlements` — which Expo writes into the app's entitlements and
// plugins/with-share-extension into the share extension's — and
// `APP_GROUP_ID` in @stxapps/expo-react, which JS uses to find the shared
// container and as the session mirror's keychain access group
// (docs/share-sheet.md). A package cannot import an app's config, hence two
// copies, and a mismatch is silent: the snapshot and the outbox land in a
// container the other process never opens, and the share extension finds no
// session. This pins them together.

import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_GROUP_FILE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'expo-react',
  'src',
  'data',
  'app-group.ts',
);

test('the App Group the targets are entitled to is the one JS opens', () => {
  const { default: appConfig } = jest.requireActual<{
    default: { ios: { entitlements: Record<string, string[]> } };
  }>('../../../app.config');
  const entitled = appConfig.ios.entitlements['com.apple.security.application-groups'];

  // Read as text: importing the module would bind expo-file-system.
  const source = fs.readFileSync(APP_GROUP_FILE, 'utf8');
  const declared = /^export const APP_GROUP_ID = '([^']+)';$/m.exec(source)?.[1];

  expect(entitled).toEqual([declared]);
});
