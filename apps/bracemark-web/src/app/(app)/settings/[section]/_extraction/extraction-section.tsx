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

import { useEffect, useRef, useState } from 'react';
// ImageDown, not Sparkles: previews are a plain fetch of <title>/og:image, with
// no model anywhere in the path. Sparkles is reserved for the parked `aiTier`
// entitlement (plans.ts) — lending it to a deterministic fetch is exactly the
// conflation that entitlement is kept separate to avoid, and it reads as vague
// magic right beside a privacy-load-bearing opt-in.
import { ImageDown, Pause } from 'lucide-react';
import Link from 'next/link';

import { PLAN_LABELS } from '@stxapps/shared';
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
  const {
    done: doneCount,
    pending: pendingCount,
    failedTransient: failedTransientCount,
    failedPermanent: failedPermanentCount,
  } = useExtractionCounts();

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

  // Focus has to be carried across that step BY HAND, because the step replaces
  // the control that was clicked: "Generate all" unmounts to make room for the
  // question, so a keyboard user is dropped on <body> and a screen reader hears
  // nothing at the moment the screen is asking them something. The two peer
  // two-steps (Delete account, Delete all data) never hit this — they gate on an
  // always-mounted checkbox, so there is nothing to restore.
  //
  // Focus lands on the GROUP, not on Confirm. Focusing the affirmative button of
  // a confirm step arms Enter, and a repeated Enter on "Generate all" would then
  // walk straight through the step that exists to slow this job down. The group
  // is labelled by the question, so what gets announced is the cost sentence,
  // and Confirm stays one Tab away. It carries `outline-none` for the reason
  // DialogContent does: the row appearing IS the feedback, and this is a
  // programmatic focus target rather than a control.
  //
  // The other direction — the drain finishing on its own, Pause → Generate all —
  // needs nothing: both branches render a `Button` in the same slot, so React
  // reconciles them into one DOM node and focus rides along.
  const confirmGroupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set by the three handlers that cause a swap, consumed by the effect below.
  // Any other render leaves it null and moves nothing — focus is never taken
  // from wherever the user actually put it.
  const focusAfterSwap = useRef<'group' | 'trigger' | null>(null);
  useEffect(() => {
    const slot = focusAfterSwap.current;
    focusAfterSwap.current = null;
    if (slot === 'group') confirmGroupRef.current?.focus();
    // If the auto drain emptied the queue while the question was up, Cancel
    // returns to a `disabled` trigger, which cannot hold focus. Nothing to do
    // here — the alternative is parking focus on a control that does nothing.
    else if (slot === 'trigger') triggerRef.current?.focus();
  });
  // Surface a failed toggle write (e.g. no active account) rather than swallow
  // it; the control stays live for a retry. Mirrors MiscSection's `run`.
  const [error, setError] = useState<string | null>(null);

  const setEnabled = (next: boolean) => {
    setError(null);
    void setServerExtraction(next).catch((e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const total = doneCount + pendingCount + failedTransientCount + failedPermanentCount;

  // All three swap the contents of the button slot, so all three hand focus on.
  // `extractAll` flips `isExtractingAll` in the same event, so the slot the
  // effect focuses is Pause by the time it runs.
  const askExtractAll = () => {
    focusAfterSwap.current = 'group';
    setConfirming(true);
  };
  const cancelExtractAll = () => {
    focusAfterSwap.current = 'trigger';
    setConfirming(false);
  };
  const startExtractAll = () => {
    focusAfterSwap.current = 'trigger';
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
          description={`The browser extension tries to fill in a title and preview image whenever you save. The mobile app can also fill pending synced and imported links on-device when its Link previews setting covers All links. Server previews inside this web app are part of the ${PLAN_LABELS.plus} plan.`}
        />
        <SettingsRow
          title="Server previews"
          description="Upgrade to fill pending previews through the web app as links come into view, or generate them for the full library."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/subscription">Upgrade to {PLAN_LABELS.plus}</Link>
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
        description="The browser extension tries to fill in a title and preview image whenever you save. The mobile app fetches previews on-device: saved links by default, or every pending link that comes into view when its setting covers All links. This web app cannot fetch other sites directly. Turn on server previews below and pending links fill in as you browse; Generate all covers the full library."
      />

      <SettingsRow
        title={
          // A Label, NOT a plain string, because this row's action is a Switch
          // and the `htmlFor` pairing is the only thing that names it — Switch
          // carries no aria-label, so dropping the Label leaves a control that
          // announces as "switch, off" with nothing saying what it toggles (and
          // takes click-the-title-to-toggle with it). Nothing catches that: no
          // lint rule, no type error, no test.
          //
          // Which is why BOTH of its type classes are overridden here. Label is
          // `text-sm font-normal` (label.tsx), and SettingsRow renders a title as
          // `font-medium` at the pane's inherited 16 (settings-kit.tsx) — so left
          // alone, the one row whose title is a Label renders lighter AND smaller
          // than every other row's. The free-plan branch above is the proof: it
          // passes these same words as a plain string, and the two would render
          // at different sizes depending on the reader's plan.
          <Label htmlFor="server-extraction" className="text-base font-medium">
            Server previews
          </Label>
        }
        // "Never your account" is the claim that holds; "or anything else" was the
        // one that did not. A request carries the IP address it came from whether
        // we want it or not, and the extractor's rate limiter is keyed on exactly
        // that (apps/bracemark-extractor/src/middleware/rate-limit.ts) — so the
        // absolute was falsifiable by anyone who thought about how the cap in
        // front of an anonymous service could possibly work. /privacy and
        // /extractor already named the IP; the toggle that turns the thing ON is
        // the last place that should be quieter than the policy page.
        description="Fetch pending links through the preview server to fill in their titles and images. While this is on, links shown on screen are handled automatically and Generate all covers the full library. Each request sends the link’s URL but no account identity. The rate limiter briefly holds the requesting IP address."
        action={
          <Switch id="server-extraction" checked={serverExtraction} onCheckedChange={setEnabled} />
        }
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {serverExtraction && !enabled ? (
        <SettingsNotice tone="pending">
          Server previews are on but currently unavailable — they resume once you’re signed in and
          the server is reachable.
        </SettingsNotice>
      ) : enabled ? (
        <div className="flex flex-col gap-4">
          {/* 2x2, and the ROWS carry meaning: the happy path on top, the two
              failure kinds paired underneath. `Will retry` / `Won't retry` reads
              as one distinction rather than two unrelated numbers, which is the
              whole point of splitting them — a single "Failed" stat merged a
              count that moves with one that can't, so the settled half looked
              like a stuck queue. A 1x4 row would flatten the pairing back out,
              and "With preview" / "Won't retry" wrap badly at narrow widths. */}
          <div className="grid grid-cols-2 gap-3">
            <Stat label="With preview" value={doneCount} />
            <Stat label="Pending" value={pendingCount} />
            <Stat label="Will retry" value={failedTransientCount} />
            <Stat label="Won’t retry" value={failedPermanentCount} />
          </div>

          <p className="text-sm text-muted-foreground">
            {total === 0
              ? 'No links to preview yet.'
              : `${doneCount} of ${total} link${total === 1 ? '' : 's'} previewed.`}
          </p>

          {/* What "Won't retry" COVERS — the one stat here that never drains on
              its own, so it is the one a user reads as broken. The label now
              carries the fact that we have stopped, which is why this line only
              has to name the causes; they track `verdictForStatus`
              (packages/shared/src/extract/retry.ts), so widening or narrowing the
              permanent set makes this false with no failing test. /faq's
              `no-title-image` says the same thing at more length.

              It does NOT claim the number is frozen: trashing one of these links
              drops it, since every bucket subtracts its trashed share
              (readExtractionFacetCounts).

              Deliberately NOT role="alert": this mounts when the count first
              crosses zero, which during a Generate all run is mid-drain, and it
              is an explanation of a stat rather than an error the user just
              caused — announcing it would be the inverse bug in
              docs/accessibility.md. The failure ITSELF is per-link and already
              visible in the count. */}
          {failedPermanentCount > 0 && (
            <p className="text-sm text-muted-foreground">
              Won’t retry means the page gave us nothing to use — it sits behind a login or a
              paywall, it isn’t a web page, or it turns away automated requests. Those links are
              saved either way, and you can give them a title of your own.
            </p>
          )}

          {autoLimitReached && !isExtractingAll && (
            <SettingsNotice tone="pending">
              Automatic previews paused for this session. Use <strong>Generate all</strong> to
              finish the remaining links.
            </SettingsNotice>
          )}

          <div>
            {isExtractingAll ? (
              <Button ref={triggerRef} variant="outline" onClick={pause}>
                <Pause data-icon="inline-start" className="size-4" />
                {isRunning ? 'Generating… Pause' : 'Pause'}
              </Button>
            ) : confirming ? (
              <div
                ref={confirmGroupRef}
                role="group"
                aria-labelledby="extract-all-confirm"
                tabIndex={-1}
                className="flex flex-wrap items-center gap-3 outline-none"
              >
                <span id="extract-all-confirm" className="text-sm">
                  Generate previews for all {pendingCount} pending link
                  {pendingCount === 1 ? '' : 's'}? This sends a request per link to the server.
                </span>
                <div className="flex gap-2">
                  <Button onClick={startExtractAll}>Confirm</Button>
                  <Button variant="ghost" onClick={cancelExtractAll}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                ref={triggerRef}
                variant="outline"
                disabled={pendingCount === 0}
                onClick={askExtractAll}
              >
                <ImageDown data-icon="inline-start" className="size-4" />
                Generate all
              </Button>
            )}
          </div>
        </div>
      ) : null}
    </SettingsPane>
  );
}
