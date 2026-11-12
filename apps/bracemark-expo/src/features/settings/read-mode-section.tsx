import { useState } from 'react';
import { Platform, View } from 'react-native';

import { useEntitlements, useSettingMutations, useSettings } from '@stxapps/expo-react';
import { PLAN_LABELS } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { Text } from '../../components/ui/text';
import { usePaywall } from '../../contexts/paywall-provider';
import { SettingsHeader, SettingsNotice, SettingsPane, SettingsRow } from './settings-kit';

// Settings → Read mode — the expo half of bracemark-web's
// `_read-mode/read-mode-section.tsx` (its header says why this is a section of its
// own rather than a group under Link previews): the SYNCED kept-copies setting,
// resolved by `keepOnSaveOf` (read mode on, its images on, screenshot off by
// default). docs/link-extraction-keep.md, _when a copy is taken_.
//
// A switch is rendered only where it changes something ON THIS DEVICE — a setting with
// no effect on the device holding it is worse than none:
//
//   - _Keep images in read mode_ — both platforms. It qualifies EVERY read-mode copy the
//     account takes, so it governs the capture screen's _Keep read mode_ here, and on
//     iOS a Safari share's copy too.
//   - _Keep read mode on save_ — iOS only. The one save on a phone that takes a copy is
//     a share from Safari, whose page the preprocessing file reads before the sheet
//     opens (docs/share-sheet.md); the app's drain keeps it only when this says so. An
//     Android share carries the URL alone, and an on-device read of a saved page's
//     HTML was measured and not built (_per client_, bracemark-expo), so on Android
//     the switch would do nothing here.
//   - no screenshot switch on either: the phone takes none (_the scope each copy
//     stops at_).
//
// The setting is synced, so flipping one here changes what the browser extension keeps
// too; the descriptions say so where it would surprise.
//
// On free the switches are shown OFF and disabled with the upgrade beside them — web's
// shape, and its reason: the setting is the clearest description of what the plan
// adds. The stored value is left alone, so an account that downgrades and comes back
// keeps its choice.
export function ReadModeSection() {
  const { entitlements } = useEntitlements();
  const { keepOnSave, deviceExtractionMode } = useSettings();
  const { setKeepOnSave } = useSettingMutations();
  const paywall = usePaywall();
  const [error, setError] = useState<string | null>(null);

  const entitled = entitlements.keptCopies;
  const ios = Platform.OS === 'ios';

  const set = (patch: { readMode?: boolean; readModeImages?: boolean }) => {
    setError(null);
    void setKeepOnSave(patch).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <SettingsPane>
      <SettingsHeader
        title="Read mode"
        description={
          ios
            ? 'Read mode keeps a page’s article — its text and pictures — with the link. Keep one with Read in a link’s menu, or when you share a page from Safari.'
            : 'Read mode keeps a page’s article — its text and pictures — with the link. Keep one with Read in a link’s menu.'
        }
      />
      <View className="gap-3">
        {ios ? (
          <SettingsRow
            title="Keep read mode on save"
            description="Keeps a page’s text when you share it from Safari to Bracemark. The setting syncs, so saves with the browser extension follow it too."
            action={
              <Switch
                testID="keep-read-mode-on-save"
                accessibilityLabel="Keep read mode on save"
                value={entitled && keepOnSave.readMode}
                disabled={!entitled}
                onValueChange={(readMode) => set({ readMode })}
              />
            }
          />
        ) : null}
        <SettingsRow
          title="Keep images in read mode"
          description="The pictures in the article, kept with its text. They take far more room than the text does — turn this off to keep words only."
          action={
            <Switch
              testID="keep-read-mode-images"
              accessibilityLabel="Keep images in read mode"
              value={entitled && keepOnSave.readModeImages}
              disabled={!entitled}
              onValueChange={(readModeImages) => set({ readModeImages })}
            />
          }
        />
        {!entitled ? (
          <SettingsRow
            title={`A ${PLAN_LABELS.plus} feature`}
            description="Copies you have already kept stay readable on every plan."
            action={
              <Button
                variant="outline"
                size="sm"
                testID="kept-copies-upgrade"
                onPress={() => paywall.show('keptCopies')}
              >
                <Text>Upgrade to {PLAN_LABELS.plus}</Text>
              </Button>
            }
          />
        ) : null}
      </View>
      {/* With the device's fetch mode at `off`, a Safari share's images are not fetched
          (share-bridge.tsx — they are this app's requests to the saved site), while
          the capture screen's Keep read mode, an explicit ask on a page the user has open,
          still fetches them.
          Standing text, so no role. iOS only: Android has no share that carries a copy. */}
      {ios && entitled && keepOnSave.readModeImages && deviceExtractionMode === 'off' ? (
        <SettingsNotice tone="info">
          With Link previews off, a page shared from Safari keeps its text only. Keep read mode
          still keeps its pictures.
        </SettingsNotice>
      ) : null}
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    </SettingsPane>
  );
}
