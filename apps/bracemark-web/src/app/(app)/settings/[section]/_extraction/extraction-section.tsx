'use client';

// The Extraction settings section: the opt-in toggle + link enrichment progress
// + the explicit full-library controls. Server extraction fills in a saved
// link's title/image via bracemark-extractor; the drain loop itself lives in
// web-react's ExtractionProvider (mounted in (app)/layout.tsx), so this section
// is a thin controls surface:
//   - the `serverExtraction` toggle (the privacy-load-bearing opt-in — no URL
//     leaves the browser until it's on), a synced setting read/written through
//     useSettings/useSettingMutations, colocated here with the controls it
//     governs rather than split off into Misc;
//   - progress from the exact facet counts (done / pending / failed) via
//     useExtractionCounts — mounted HERE, on demand, because exactness carries an
//     O(trash) trash-correction join that shouldn't ride the always-on provider;
//   - "Extract all" to drain the WHOLE library (a conscious, potentially
//     thousands-of-requests job — so it confirms at the button first, per
//     docs/link-extraction.md), and "Pause" to stop it early.
// The whole feature is self-contained in this one section so a platform that
// does its own extraction (bracemark-expo) can drop it by omitting the section.
// The incidental, displayed-scoped auto drain is driven from the links pane
// (reportDisplayedLinkPaths) and needs no UI here.

import { useState } from 'react';
import { Pause, Sparkles } from 'lucide-react';
import Link from 'next/link';

import {
  useEntitlements,
  useExtraction,
  useExtractionCounts,
  useSettingMutations,
  useSettings,
} from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { Switch } from '@stxapps/web-ui/components/ui/switch';

import {
  SettingsHeader,
  SettingsNotice,
  SettingsPane,
  SettingsRow,
} from '../../_components/settings-kit';

// One labelled count in a bordered tile.
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border p-3">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}

export function ExtractionSection() {
  const { enabled, isRunning, isExtractingAll, autoLimitReached, extractAll, pause } =
    useExtraction();
  const { done: doneCount, pending: pendingCount, failed: failedCount } = useExtractionCounts();

  // The opt-in itself. `enabled` above is the composite gate (signed in + store
  // ready + extractor configured + this), so the toggle binds to the raw
  // `serverExtraction` setting — flipping it on when e.g. no extractor is
  // configured still persists the preference; `enabled` just stays false.
  const { serverExtraction } = useSettings();
  const { setServerExtraction } = useSettingMutations();

  // Plan gate: opting in to `bracemark-extractor` is a Plus/Pro entitlement (the
  // `serverExtraction` gate). This is a
  // client-enforced UX gate: free stores client-extracted preview images fine,
  // but the paid, abuse-exposed SERVER extraction path is what's gated. Free
  // accounts see the upsell instead of the toggle; the synced `serverExtraction`
  // preference itself is untouched, so it comes back if they upgrade.
  const { entitlements } = useEntitlements();

  // Two-step confirm for "Extract all": the first click reveals the count +
  // Confirm, since draining the whole library can be thousands of paid requests.
  const [confirming, setConfirming] = useState(false);
  // Surface a failed toggle write (e.g. no active account) rather than swallow
  // it; the control stays live for a retry. Mirrors MiscSection's `run`.
  const [error, setError] = useState<string | null>(null);

  const setEnabled = (next: boolean) => {
    setError(null);
    void setServerExtraction(next).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const total = doneCount + pendingCount + failedCount;

  const startExtractAll = () => {
    setConfirming(false);
    extractAll();
  };

  // Free plan: the whole feature is a Plus/Pro entitlement, so the section is
  // an upsell instead of controls (after all hooks — no conditional hook calls).
  if (!entitlements.serverExtraction) {
    return (
      <SettingsPane>
        <SettingsHeader
          title="Link previews"
          description="Bracemark fills in each saved link's title and preview image automatically. Links saved from the Bracemark extension are previewed right on your device; previews for links saved on the web or added by import are part of the Plus plan."
        />
        <SettingsRow
          title="Server-side previews"
          description="Upgrade to fill in titles and preview images for links that weren't previewed on the device that saved them."
          action={
            <Button asChild variant="outline">
              <Link href="/settings/subscription">Upgrade to Plus</Link>
            </Button>
          }
        />
      </SettingsPane>
    );
  }

  return (
    <SettingsPane>
      <SettingsHeader
        title="Link previews"
        description="Bracemark fills in each saved link's title and preview image automatically — you don't need to do it by hand. Links you save from the Bracemark extension or mobile app are previewed right on your device, so the page never leaves it. For links saved on the web or added by import, turn on server-side previews below and Bracemark will fetch them for you."
      />

      <SettingsRow
        title={
          <Label htmlFor="server-extraction" className="font-medium">
            Server-side previews
          </Label>
        }
        description="Fetch each link on the server to fill in its title and preview image — for links that weren't previewed on the device that saved them. Only the link's URL is sent, never your account or anything else, and only while this is on."
        action={
          <Switch id="server-extraction" checked={serverExtraction} onCheckedChange={setEnabled} />
        }
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {serverExtraction && !enabled ? (
        <SettingsNotice tone="pending">
          Server-side previews are on but currently unavailable — they resume once you're signed in
          and the server is reachable.
        </SettingsNotice>
      ) : enabled ? (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="With preview" value={doneCount} />
            <Stat label="Pending" value={pendingCount} />
            <Stat label="Failed" value={failedCount} />
          </div>

          <p className="text-sm text-muted-foreground">
            {total === 0
              ? 'No links to preview yet.'
              : `${doneCount} of ${total} link${total === 1 ? '' : 's'} previewed.`}
          </p>

          {autoLimitReached && !isExtractingAll && (
            <SettingsNotice tone="pending">
              Automatic previews paused for this session. Use <strong>Generate all</strong> to
              finish the remaining links.
            </SettingsNotice>
          )}

          <div>
            {isExtractingAll ? (
              <Button variant="outline" onClick={pause}>
                <Pause data-icon="inline-start" className="size-4" />
                {isRunning ? 'Generating… Pause' : 'Pause'}
              </Button>
            ) : confirming ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm">
                  Generate previews for all {pendingCount} pending link
                  {pendingCount === 1 ? '' : 's'}? This sends a request per link to the server.
                </span>
                <div className="flex gap-2">
                  <Button onClick={startExtractAll}>Confirm</Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                disabled={pendingCount === 0}
                onClick={() => setConfirming(true)}
              >
                <Sparkles data-icon="inline-start" className="size-4" />
                Generate all
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </SettingsPane>
  );
}
