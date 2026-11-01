'use client';

import { useState } from 'react';
import Link from 'next/link';

import { PLAN_LABELS } from '@stxapps/shared';
import { useEntitlements, useSettingMutations, useSettings } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Switch } from '@stxapps/web-ui/components/ui/switch';

import { SettingsGroup, SettingsNotice, SettingsRow } from '../../_components/settings-kit';

// Settings → Link previews → Kept copies: the synced save setting
// (`keepReadModeOnSave` / `keepScreenshotOnSave`, resolved by `keepOnSaveOf` — read
// mode on, screenshot off by default). docs/link-extraction-keep.md, _when a copy is
// taken_.
//
// It lives in Link previews rather than a section of its own because it is the same
// question asked one step further — what does a save fetch and keep — and because a
// section with two switches would be the thinnest page in Settings.
//
// What the copy must not claim: that THIS app takes copies. It can't — a copy is
// taken from the page itself, which only the browser extension has open (the web
// app can't fetch another site; the server path for read mode is not built). So the
// description names the browser extension, and the setting is synced so the
// browser extension picks it up wherever it is installed. Saying "when you save"
// unqualified would promise a copy for a save made here, which never gets one.
//
// On free the switches are shown OFF and disabled, with the upgrade beside them —
// the same shape as Server previews' upgrade row — rather than hidden: the setting
// is the clearest description of what the plan adds. The stored value is left
// alone, so an account that downgrades and comes back keeps its choice.
export function KeptCopiesGroup() {
  const { entitlements } = useEntitlements();
  const { keepOnSave } = useSettings();
  const { setKeepOnSave } = useSettingMutations();
  const [error, setError] = useState<string | null>(null);

  const entitled = entitlements.keptCopies;

  const set = (patch: { readMode?: boolean; screenshot?: boolean }) => {
    setError(null);
    void setKeepOnSave(patch).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <SettingsGroup
      title="Kept copies"
      description="When you save a page with the Bracemark browser extension, it can also keep a copy of it from the open tab: the text in read mode, and a screenshot of how it looked. Read kept copies from a link’s menu. Saving here in the web app can’t keep a copy — the page isn’t open."
    >
      <SettingsRow
        title={
          <Label htmlFor="keep-read-mode" className="text-base font-medium">
            Keep read mode on save
          </Label>
        }
        description="The page’s article text, without ads or menus. Small, and readable offline."
        action={
          <Switch
            id="keep-read-mode"
            checked={entitled && keepOnSave.readMode}
            disabled={!entitled}
            onCheckedChange={(readMode) => set({ readMode })}
          />
        }
      />
      <SettingsRow
        title={
          <Label htmlFor="keep-screenshot" className="text-base font-medium">
            Keep a screenshot on save
          </Label>
        }
        description="What the page showed when you saved it. Larger than read mode — you can also take one from the saved screen, page by page."
        action={
          <Switch
            id="keep-screenshot"
            checked={entitled && keepOnSave.screenshot}
            disabled={!entitled}
            onCheckedChange={(screenshot) => set({ screenshot })}
          />
        }
      />
      {!entitled ? (
        <SettingsRow
          title={`A ${PLAN_LABELS.plus} feature`}
          description="Copies you have already kept stay readable on every plan."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/subscription">Upgrade to {PLAN_LABELS.plus}</Link>
            </Button>
          }
        />
      ) : null}
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    </SettingsGroup>
  );
}
