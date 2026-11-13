import { useState } from 'react';
import { Platform, View } from 'react-native';
import { router } from 'expo-router';

import { useEntitlements, useSettingMutations, useSettings } from '@stxapps/expo-react';
import { PAYWALL_COPY } from '@stxapps/react';
import { PLAN_LABELS } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Text } from '../../components/ui/text';
import { SettingsHeader, SettingsNotice, SettingsPane, SettingsRow } from './settings-kit';

// Settings → Read mode — the expo half of bracemark-web's
// `_read-mode/read-mode-section.tsx`: the SYNCED kept-copies setting, resolved by
// `keepOnSaveOf` (read mode on, its images off, screenshot off by default).
// docs/link-extraction-keep.md, _when a copy is taken_.
//
// A switch is rendered only where it changes something ON THIS DEVICE — a setting with
// no effect on the device holding it is worse than none. The rule is the product's,
// not this app's: bracemark-web keeps only the images switch, and the two on-save
// switches live on the browser extension's options page
// (entrypoints/options/CopiesSection.tsx), the client they govern. Here:
//
//   - _Include images in read-mode copies_ — both platforms. It qualifies EVERY
//     read-mode copy the account takes, so it governs the capture screen's _Keep a
//     copy_ here, and on iOS a Safari share's copy too.
//   - _Keep a read-mode copy when you share from Safari_ — iOS only. The one save on a
//     phone that takes a copy is a share from Safari, whose page the preprocessing file
//     reads before the sheet opens (docs/share-sheet.md); the app's drain keeps it only
//     when this says so. An Android share carries the URL alone, and an on-device read
//     of a saved page's HTML was measured and not built (_per client_, bracemark-expo),
//     so on Android the switch would do nothing here. Its key is `keepReadModeOnShare`,
//     the phone's own — not the browser extension's `keepReadModeOnSave` — so flipping
//     it here changes nothing in a browser, and its description needs no warning that
//     it would (entities.ts says why the two split).
//   - no screenshot switch on either: the phone takes none (_the scope each copy
//     stops at_).
//
// Titles carry their own "when", rather than sitting under group headings: the same
// three titles read the same on all three surfaces, whichever subset a surface shows.
// "a read-mode copy", never bare "read mode", as the object of a verb — "Keep read mode
// on save" read as "keep read mode ON" (docs/brand-assets.md, _terminology_).
//
// On free the section is the header and one upgrade row, web's shape and its reasons
// (a disabled switch says nothing about why; one shown off over a stored on can't be
// trusted). The row already prints PAYWALL_COPY.keptCopies, so Upgrade goes straight
// to the Subscription screen rather than through `paywall.show`, whose dialog would
// only repeat the same title and sentence over it. The stored value is left alone, so
// an account that downgrades and comes back keeps its choice.
export function ReadModeSection() {
  const { entitlements } = useEntitlements();
  const { keepOnSave, deviceExtractionMode } = useSettings();
  const { setKeepOnSave } = useSettingMutations();
  const [error, setError] = useState<string | null>(null);

  const ios = Platform.OS === 'ios';

  const header = (
    <SettingsHeader
      title="Read mode"
      description="A read-mode copy is the article on a page — its text and images, without the ads and menus — kept with the link, so you can still read it after the page changes, moves or goes behind a sign-in. Open or keep one with Read in a link’s menu."
    />
  );

  if (!entitlements.keptCopies) {
    const upsell = PAYWALL_COPY.keptCopies;
    return (
      <SettingsPane>
        {header}
        <SettingsRow
          title={upsell.title}
          description={upsell.description}
          action={
            <Button
              variant="outline"
              size="sm"
              testID="kept-copies-upgrade"
              onPress={() => router.push('/settings/subscription')}
            >
              <Text>Upgrade to {PLAN_LABELS[upsell.plan]}</Text>
            </Button>
          }
        />
      </SettingsPane>
    );
  }

  const set = (patch: { readModeOnShare?: boolean; readModeImages?: boolean }) => {
    setError(null);
    void setKeepOnSave(patch).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <SettingsPane>
      {header}
      <View className="gap-3">
        {ios ? (
          <SettingsRow
            title="Keep a read-mode copy when you share from Safari"
            description="The page’s article, without ads or menus, taken as you share it to Bracemark."
            action={
              <Switch
                testID="keep-read-mode-on-share"
                accessibilityLabel="Keep a read-mode copy when you share from Safari"
                value={keepOnSave.readModeOnShare}
                onValueChange={(readModeOnShare) => set({ readModeOnShare })}
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Include images in read-mode copies"
          description="The article’s images, kept with its text in every read-mode copy you keep. They use far more storage than the text does; with this off, a copy keeps its text only. Copies you have already kept don’t change."
          action={
            <Switch
              testID="keep-read-mode-images"
              accessibilityLabel="Include images in read-mode copies"
              value={keepOnSave.readModeImages}
              onValueChange={(readModeImages) => set({ readModeImages })}
            />
          }
        />
      </View>
      {/* With the device's fetch mode at `off`, a Safari share's images are not fetched
          (share-bridge.tsx — they are this app's requests to the saved site), while
          the capture screen's Keep a copy, an explicit ask on a page the user has
          open, still fetches them.
          Standing text, so no role. iOS only: Android has no share that carries a copy. */}
      {ios && keepOnSave.readModeImages && deviceExtractionMode === 'off' ? (
        <SettingsNotice tone="info">
          With Link previews off, a page you share from Safari keeps its text only. Keep a copy,
          from a link’s Read, still keeps its images.
        </SettingsNotice>
      ) : null}
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    </SettingsPane>
  );
}
