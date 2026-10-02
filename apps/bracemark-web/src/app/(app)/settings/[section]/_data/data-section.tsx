'use client';

// The Data settings section: the home for everything about the bytes you own —
// sync status up top, then the three data-lifecycle actions (import / export /
// delete-all). It mirrors the old SettingsPopupData's shape (an overview that
// lists the actions, each opening a focused screen with a Back link) but as
// in-section VIEW STATE rather than routes: the settings model is one static
// route per top-level section, so these transient one-shot screens live as a
// local `view` swap inside this one section, self-contained in `_data/` like
// the other sections.
//
// All three actions are real. Export: format choice (ExportView), the
// locked-lists exclusion warning, progress, and the result line, over
// web-react's useExportAllData → data/export-all-data.ts. Import: a picked file,
// auto-detected format, progress, and the result line, over useImportAllData →
// data/import-all-data.ts.
// Delete-all: checkbox gate + one server wipe call + the local wipe, over
// useDeleteAllData → data/delete-all-data.ts (see docs/data-lifecycle.md —
// the account itself is untouched; deleting THAT lives in the Account section).

import { useRef, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  CloudOff,
  Download,
  FileText,
  Globe,
  Loader2,
  Lock,
  Package,
  Sheet,
  Trash2,
  Upload,
} from 'lucide-react';
import Link from 'next/link';

import {
  type ExportFormat,
  formatSyncedAt,
  getSyncPhase,
  type ImportQuotaAnswer,
  type ImportQuotaPrompt,
  SYNC_PHASE_LABELS,
  syncBlockedDetail,
} from '@stxapps/shared';
import {
  type DeleteAllState,
  type ExportState,
  type ImportState,
  useDeleteAllData,
  useExportAllData,
  useImportAllData,
  useLocks,
  usePendingChangesCount,
  useSync,
} from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import { Label } from '@stxapps/web-ui/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@stxapps/web-ui/components/ui/radio-group';

import {
  SettingsHeader,
  SettingsNotice,
  SettingsPane,
  SettingsRow,
} from '../../_components/settings-kit';

type DataView = 'overview' | 'import' | 'export' | 'delete';

// The sync status card: collapses the two sync dimensions into one phase
// (@stxapps/shared's getSyncPhase — same derivation as the extension popup)
// with an icon, an optional detail, and the single relevant action (Sync now /
// Retry). Sync is status-based, not a percentage, so there's no progress bar;
// the pending-changes line is the "how much is left" signal instead.
function SyncStatus() {
  const { storeStatus, bgSyncStatus, lastSyncAt, lastError, blockedCount, syncNow } = useSync();
  const pendingCount = usePendingChangesCount();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);
  // Rendered inside InitialSyncGate, so storeStatus is never 'error' here —
  // 'initial-error' and its retryInitialSync belong to the gate's own screen.
  // Still counted as an error so that, should the gate ever let it through, it
  // reads as the failure it is rather than falling through to the spinner. No
  // Retry for it: syncNow runs a background cycle, not the initial pull.
  const isError = phase === 'cycle-error' || phase === 'initial-error';
  // The quota gate refused part of the push. Deliberately NOT styled as an
  // error: everything else synced and the local library is intact — what's
  // needed is some freed space, not a retry (which is also why it gets no Retry
  // button; pressing one would change nothing).
  const isBlocked = phase === 'capacity-blocked';
  // The session expired (docs/sessions.md): no cycle runs until a sign-in, so no
  // spinner and no button here — the "Sign in to resume" notice above the section
  // carries the one action. Not an error either: nothing failed, nothing is lost.
  const isPaused = phase === 'paused';

  // `size-5` is the SettingsRow icon size — the three action rows below, and
  // account-section's four. NOT the `size-4` the receipts and SettingsNotice use
  // further down this file: that one is an inline glyph beside 14px text, a
  // different slot that happens to hold the same three lucide shapes.
  const icon = isError ? (
    <CircleAlert className="size-5 text-destructive" />
  ) : isBlocked ? (
    <CircleAlert className="size-5 text-muted-foreground" />
  ) : isPaused ? (
    <CloudOff className="size-5 text-muted-foreground" />
  ) : phase === 'idle' ? (
    <CircleCheck className="size-5 text-muted-foreground" />
  ) : (
    <Loader2 className="size-5 animate-spin text-muted-foreground" />
  );

  const text =
    phase === 'idle' && lastSyncAt
      ? `Last synced ${formatSyncedAt(lastSyncAt)}`
      : SYNC_PHASE_LABELS[phase];
  const detail = isError ? lastError : null;
  const action =
    phase === 'cycle-error'
      ? { label: 'Retry', onClick: syncNow }
      : phase === 'idle'
        ? { label: 'Sync now', onClick: syncNow }
        : null;

  return (
    <SettingsRow
      // The wrapper is what aligns the glyph, and both halves of it are load-
      // bearing. This row is STATIC (no onClick), so the kit lays it out
      // `items-start` rather than the `items-center` the pressable rows below get
      // (settings-kit.tsx) — deliberately, because this description is a column of
      // up to five lines that mount and unmount with sync state, and a centred
      // icon would drift down the row as they appear. `mt-0.5` then drops the
      // 20px glyph onto the optical centre of the 24px title line, and `block` is
      // what makes that margin apply at all — the kit's own wrapper span is
      // inline, where vertical margins do nothing.
      icon={<span className="mt-0.5 block">{icon}</span>}
      title="Sync"
      action={
        action ? (
          <Button variant="outline" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ) : null
      }
      description={
        <>
          <span className={`text-sm ${isError ? 'text-destructive' : 'text-muted-foreground'}`}>
            {text}
          </span>
          {detail && <span className="wrap-break-words text-sm text-destructive">{detail}</span>}
          {/* The one place a blocked sync is explained. Inline rather than the
              hoisted paywall dialog: this is a STATUS the user came to read,
              not an action being interrupted (paywall-provider's header). No
              "See plans" link — the only refusal left is the storage ceiling,
              which upgrading a PLAN doesn't clear on a paid account and which
              the pricing page cannot help with. The fix is in the sentence. */}
          {isBlocked && (
            <span className="text-sm text-muted-foreground">
              {syncBlockedDetail(phase, blockedCount)} Everything already saved is safe.
            </span>
          )}
          {pendingCount > 0 && (
            <span className="text-sm text-muted-foreground">
              {pendingCount} {pendingCount === 1 ? 'change' : 'changes'} waiting to sync
            </span>
          )}
          {/* Qualifies what a settled sync means: link metadata is on this
              device, while image blobs download on demand as virtualized rows
              mount (docs/local-first-sync.md — metadata vs. content). Suppressed
              on an error, where a standing fact only competes with the failure,
              and while paused, where it stops being a fact: an expired session
              behaves as offline (docs/sessions.md), so an image not already on
              this device doesn't download until the user signs in again. */}
          {!isError && !isBlocked && !isPaused && (
            <span className="mt-1 text-xs text-muted-foreground">
              Images download as links come into view.
            </span>
          )}
        </>
      }
    />
  );
}

const IMPORT_STEP_LABELS: Record<'sync' | 'parse' | 'items' | 'files', string> = {
  sync: 'Refreshing from the server…',
  parse: 'Reading the file…',
  items: 'Importing links…',
  files: 'Importing files…',
};

// The one-line receipt under the import button: progress while running, the
// counts + any warnings when done, the failure (quota message verbatim) when
// errored — the import twin of ExportStatus.
function ImportStatus({ state }: { state: ImportState }) {
  // 'quota' has its own surface (ImportQuotaChoice) — a decision, not a status.
  if (state.phase === 'idle' || state.phase === 'quota') return null;

  if (state.phase === 'running') {
    const counts =
      state.done !== undefined && state.total !== undefined && state.total > 0
        ? ` (${state.done} of ${state.total})`
        : '';
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {IMPORT_STEP_LABELS[state.step]}
        {counts}
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="wrap-break-words">Import failed: {state.message}</span>
      </p>
    );
  }

  const { outcome } = state;
  const nothingFound =
    outcome.linkCount === 0 && outcome.fileCount === 0 && outcome.skippedCount === 0;
  if (nothingFound) {
    return (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>No links were found in that file.</span>
      </p>
    );
  }

  // Leads the notes, and names the number rather than saying "some": this is the
  // one outcome where the library deliberately does not match the file, and the
  // user chose it several seconds ago — they need to see it confirmed, not
  // discover it by counting.
  const truncated = outcome.notImportedCount > 0;

  const created: string[] = [];
  if (outcome.listCount > 0) {
    created.push(`${outcome.listCount} ${outcome.listCount === 1 ? 'list' : 'lists'}`);
  }
  if (outcome.tagCount > 0) {
    created.push(`${outcome.tagCount} ${outcome.tagCount === 1 ? 'tag' : 'tags'}`);
  }
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `${outcome.notImportedCount} more ${outcome.notImportedCount === 1 ? 'link' : 'links'} in the file ${outcome.notImportedCount === 1 ? 'was' : 'were'} left out — your plan was full. Import the same file again after upgrading and the rest will come in; the ones already here are skipped as duplicates.`,
    );
  }
  if (created.length > 0) notes.push(`Added ${created.join(' and ')}.`);
  if (outcome.skippedCount > 0) {
    // "duplicates", not "links": for a Bracemark-backup merge the count covers every
    // already-present entity (lists/tags/extractions too), not just links.
    notes.push(
      `${outcome.skippedCount} ${outcome.skippedCount === 1 ? 'duplicate was' : 'duplicates were'} skipped.`,
    );
  }
  if (outcome.invalidCount > 0) {
    notes.push(
      `${outcome.invalidCount} ${outcome.invalidCount === 1 ? 'entry' : 'entries'} couldn’t be read and ${outcome.invalidCount === 1 ? 'was' : 'were'} left out.`,
    );
  }
  if (outcome.syncFailed) {
    notes.push(
      'Couldn’t refresh from the server first — duplicates were checked against this device’s copy.',
    );
  }
  return (
    <div className="flex items-start gap-2 text-sm">
      {truncated ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="text-muted-foreground">
        Imported {outcome.linkCount} {outcome.linkCount === 1 ? 'link' : 'links'}
        {outcome.fileCount > 0
          ? ` and ${outcome.fileCount} ${outcome.fileCount === 1 ? 'file' : 'files'}`
          : ''}
        .{notes.map((note) => ` ${note}`).join('')}
      </span>
    </div>
  );
}

// The over-cap pre-flight: the file has been parsed and counted, nothing has
// been written, and the run is suspended on this answer. Deliberately a CHOICE
// and not the hoisted paywall dialog — the file is already picked and the user
// is mid-task, so the two things they might actually want (take what fits now,
// or stop and go get room) belong on screen next to the number that decides it.
// The plans link is the third door, not the only one; see docs/data-lifecycle.md
// (_the import's quota gate_) for why the interop path offers this at all and
// the backup path still refuses whole.
function ImportQuotaChoice({
  prompt,
  onAnswer,
}: {
  prompt: ImportQuotaPrompt;
  onAnswer: (answer: ImportQuotaAnswer) => void;
}) {
  const { newCount, existingCount, maxLinks, room } = prompt;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border px-3 py-2.5 text-sm">
      <p className="text-muted-foreground">
        This file has {newCount} new {newCount === 1 ? 'link' : 'links'}. Your plan holds {maxLinks}{' '}
        and you already have {existingCount}, so there is room for {room} more.
      </p>
      <p className="text-muted-foreground">
        Nothing has been imported yet. You can bring in the first {room}, or stop here and import
        the whole file once you have room — the file on your device is untouched either way.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onAnswer('import-what-fits')}>
          Import {room} {room === 1 ? 'link' : 'links'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onAnswer('cancel')}>
          Cancel
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/settings/subscription">See plans</Link>
        </Button>
      </div>
    </div>
  );
}

function ImportView({ onBack }: { onBack: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, run, answerQuota } = useImportAllData();
  const running = state.phase === 'running' || state.phase === 'quota';

  const onFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so picking the same file again re-fires the change event.
    event.target.value = '';
    if (file) run(file);
  };

  return (
    <>
      <SettingsHeader
        back={{ label: 'Data', onClick: onBack }}
        title="Import data"
        description="Import from a file — a Bracemark backup (.zip), a Brace.to export (.txt), an HTML bookmarks file (web browsers, Karakeep), a LinkWarden backup (.json), a Pocket export (.zip or .csv), a Raindrop.io export (.html or .csv), or a plain list of links. From Raindrop.io, choose the HTML export: its CSV turns a collection named “Work / Clients” into a Clients list inside a Work list. The format is detected automatically; links you already have are skipped. If the file holds more links than your plan has room for, we’ll count them and ask before importing anything. Large imports may take a few minutes."
      />
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.html,.htm,.csv,.txt,.json,text/html,text/csv,text/plain,application/json,application/zip"
        className="hidden"
        onChange={onFilePicked}
      />
      {/* The action and its receipt are ONE block, not two. SettingsPane is a
          `gap-8` column and that step is the rhythm between a section's top-level
          blocks — a status line belongs to the button that produced it, so the two
          sit at `gap-3` inside a wrapper and the pane's step separates the pair
          from what comes next. The receipts used to carry their own `mt-3`, which
          ADDED to the pane's gap (44px, not the 12 it was written for); the
          spacing lives here now and the status components carry no margin.

          The inner div is what keeps the button at its text width. `Button` is
          `inline-flex shrink-0`, but a direct flex child gets `align-self:
          stretch` — as a bare child of the pane this one filled the whole 672px
          measure, the only settings action in the app that did. Same wrapper the
          other seven use (account-section, extraction-section). */}
      <div className="flex flex-col gap-3">
        <div>
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={running}>
            <Upload data-icon="inline-start" className="size-4" />
            Choose a file
          </Button>
        </div>

        {state.phase === 'quota' ? (
          <ImportQuotaChoice prompt={state.prompt} onAnswer={answerQuota} />
        ) : (
          <ImportStatus state={state} />
        )}
      </div>
    </>
  );
}

// The four export formats. Three destinations (browsers, LinkWarden, Karakeep)
// share the Netscape HTML serializer, so they're one option with the
// destinations named in its hint — not three options producing identical files.
const EXPORT_FORMAT_OPTIONS: {
  value: ExportFormat;
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    value: 'bracemark',
    label: 'Bracemark backup',
    hint: 'Everything — links, lists, tags, pins, files, and settings — as a .zip you can import back into Bracemark.',
    icon: <Package className="size-4" />,
  },
  {
    value: 'netscape',
    label: 'HTML bookmarks',
    hint: 'For web browsers (Chrome, Firefox, Safari), LinkWarden, and Karakeep. Links in Trash aren’t included.',
    icon: <Globe className="size-4" />,
  },
  {
    value: 'csv',
    label: 'CSV',
    hint: 'For Raindrop.io and spreadsheets. Links in Trash aren’t included.',
    icon: <Sheet className="size-4" />,
  },
  {
    value: 'text',
    label: 'Plain text',
    hint: 'Just the URLs, one per line — opens in any text editor.',
    icon: <FileText className="size-4" />,
  },
];

const EXPORT_STEP_LABELS: Record<'sync' | 'gather' | 'files' | 'assemble', string> = {
  sync: 'Refreshing from the server…',
  gather: 'Gathering links…',
  files: 'Downloading files…',
  assemble: 'Packaging…',
};

// The one-line receipt under the export button: progress while running, the
// counts + any warnings when done, the failure when errored.
function ExportStatus({ state, excludedCount }: { state: ExportState; excludedCount: number }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    const counts =
      state.done !== undefined && state.total !== undefined && state.total > 0
        ? ` (${state.done} of ${state.total})`
        : '';
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {EXPORT_STEP_LABELS[state.step]}
        {counts}
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="wrap-break-words">Export failed: {state.message}</span>
      </p>
    );
  }

  const { outcome } = state;
  const warnings: string[] = [];
  if (outcome.syncFailed) {
    warnings.push(
      'Couldn’t refresh from the server first — this is this device’s copy of your data.',
    );
  }
  if (outcome.missingFileCount > 0) {
    warnings.push(
      `${outcome.missingFileCount} ${outcome.missingFileCount === 1 ? 'file' : 'files'} couldn’t be downloaded and ${outcome.missingFileCount === 1 ? 'was' : 'were'} left out.`,
    );
  }
  if (excludedCount > 0) {
    warnings.push(
      `${excludedCount} locked ${excludedCount === 1 ? 'list was' : 'lists were'} not included.`,
    );
  }

  // Nothing matched the policy — an empty library, or every link in Trash under
  // an interop format, or every list locked. NOT gated before the run: the save
  // picker has to be claimed inside the click's user activation, before the
  // sync/gather awaits that would tell us the count, so the emptiness can only
  // be reported afterwards (docs/data-lifecycle.md — _the export's empty run_).
  //
  // Which is why the line names the FILE first. A bare "there was nothing to
  // export" — DeleteStatus' shape, where nothing is produced — would contradict
  // the download the user is looking at; "Exported 0 links." claimed a success
  // for a file with nothing in it. Both facts, in the order they happened. The
  // warnings above then supply the reason whenever there is one (locked lists).
  const nothingExported = outcome.linkCount === 0;
  const lead = nothingExported
    ? 'The file was saved, but there were no links to put in it.'
    : `Exported ${outcome.linkCount} ${outcome.linkCount === 1 ? 'link' : 'links'}${
        outcome.fileCount > 0
          ? ` and ${outcome.fileCount} ${outcome.fileCount === 1 ? 'file' : 'files'}`
          : ''
      }.`;
  return (
    <div className="flex items-start gap-2 text-sm">
      {nothingExported ? (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="text-muted-foreground">
        {lead}
        {warnings.map((warning) => ` ${warning}`).join('')}
      </span>
    </div>
  );
}

function ExportView({ onBack }: { onBack: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('bracemark');
  const { lockedListIds } = useLocks();
  const { state, run } = useExportAllData();
  const running = state.phase === 'running';
  const lockedCount = lockedListIds.size;

  return (
    <>
      <SettingsHeader
        back={{ label: 'Data', onClick: onBack }}
        title="Export all data"
        description="Save a copy of your data. Pick the format that matches where you’ll use it. This may take a few minutes for a large library."
      />

      <RadioGroup
        value={format}
        onValueChange={(v) => setFormat(v as ExportFormat)}
        disabled={running}
      >
        {EXPORT_FORMAT_OPTIONS.map((option) => (
          <Label
            key={option.value}
            htmlFor={`export-${option.value}`}
            className="flex items-start gap-3 rounded-lg border border-border p-3 has-data-checked:border-primary has-data-checked:bg-muted/40"
          >
            <RadioGroupItem id={`export-${option.value}`} value={option.value} className="mt-0.5" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-start gap-2 font-medium">
                <span className="mt-0.5 shrink-0">{option.icon}</span>
                {option.label}
              </span>
              <span className="text-sm text-muted-foreground">{option.hint}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>

      {lockedCount > 0 && (
        <SettingsNotice icon={<Lock className="size-4" />}>
          <span>
            {lockedCount} locked {lockedCount === 1 ? 'list' : 'lists'} — and the links inside{' '}
            {lockedCount === 1 ? 'it' : 'them'} — won’t be included. Unlock{' '}
            {lockedCount === 1 ? 'it' : 'them'} first if you want everything.
          </span>
        </SettingsNotice>
      )}

      {/* Button + receipt as one `gap-3` block, inner div shrink-wraps the
          button — ImportView carries the full note. */}
      <div className="flex flex-col gap-3">
        <div>
          <Button variant="outline" onClick={() => run(format, lockedListIds)} disabled={running}>
            <Download data-icon="inline-start" className="size-4" />
            Export all data
          </Button>
        </div>

        <ExportStatus state={state} excludedCount={lockedCount} />
      </div>
    </>
  );
}

// The one-line receipt under the delete button: a single spinner while running
// (the wipe is one server call — no per-item progress to show), the count when
// done, the failure when errored (the endpoint is idempotent, so the retry is
// just clicking again).
function DeleteStatus({ state }: { state: DeleteAllState }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {state.step === 'waiting-for-sync'
          ? 'Waiting for an in-progress sync to finish safely. This can take a minute.'
          : 'Deleting all your data…'}
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="wrap-break-words">
          Delete failed: {state.message} Nothing was removed from this device — please try again.
        </span>
      </p>
    );
  }

  const { deletedCount } = state.outcome;
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <CircleCheck className="mt-0.5 size-4 shrink-0" />
      <span>
        {deletedCount === 0
          ? 'There was no data to delete.'
          : `All your data has been deleted (${deletedCount} ${deletedCount === 1 ? 'item' : 'items'}).`}
      </span>
    </p>
  );
}

function DeleteView({ onBack }: { onBack: () => void }) {
  const { state, run } = useDeleteAllData();
  const [confirmed, setConfirmed] = useState(false);
  // Reveal the "tick the box first" nudge only after a click without the box.
  const [nudge, setNudge] = useState(false);
  const running = state.phase === 'running';
  const done = state.phase === 'done';

  const onDelete = () => {
    if (!confirmed) {
      setNudge(true);
      return;
    }
    setNudge(false);
    run();
  };

  return (
    <>
      {/* The prose goes THROUGH the header, like Import's and Export's one-liners
          — this view's is three paragraphs rather than one, which is the only
          difference between them and not a reason to sit 32px lower. */}
      <SettingsHeader
        back={{ label: 'Data', onClick: onBack }}
        title="Delete all data"
        description={
          <>
            <p>
              Delete all your data — every saved link in every list, all your lists and tags, and
              all your settings — from all your devices.
            </p>
            <p>
              This removes your data only, not your account — you can still sign in. If another
              device has changes that haven’t synced yet, those changes may sync back afterward.
              Consider exporting a copy first.
            </p>
            <p className="font-medium text-destructive">This action can’t be undone.</p>
          </>
        }
      />

      {/* The nudge belongs to the CHECKBOX, so the two are one block at `gap-2`
          and the pane's `gap-8` still separates the pair from the button. Three
          things fix it here rather than beside the button:

          It says "the box above" — a validation message for a gate sits at the
          gate. The slot under the button is already spoken for by DeleteStatus,
          where "you didn't tick the box" and "the delete failed" would mount in
          the same place meaning very different things. And it is the spacing
          apps/bracemark-expo/src/features/settings/data-section.tsx already uses
          (`mt-2` to the checkbox, a block step to the button).

          The gap is also what keeps the button still. This alert mounts ON A
          CLICK, and as a bare child of the `gap-8` column it pushed the button
          52px down the page — out from under the cursor that had just pressed
          it, which on a delete-everything screen is the worst possible moment to
          move the target. Inside the group the shift is 28px, and none of it is
          the pane's step. */}
      <div className="flex flex-col gap-2">
        <Label
          htmlFor="delete-confirm"
          className="flex items-start gap-3 rounded-lg border border-border p-3"
        >
          <Checkbox
            id="delete-confirm"
            checked={confirmed}
            disabled={running || done}
            onCheckedChange={(v) => {
              setConfirmed(v === true);
              setNudge(false);
            }}
            className="mt-0.5"
          />
          <span className="text-sm">Yes, I’m absolutely sure I want to delete all my data.</span>
        </Label>

        {nudge && (
          <p role="alert" className="text-sm text-destructive">
            Please tick the box above to confirm.
          </p>
        )}
      </div>

      {/* Button + receipt as one `gap-3` block, inner div shrink-wraps the
          button — ImportView carries the full note. Text width matters most on
          THIS one: the checkbox above is the gate, and a delete button stretched
          to the full measure would be the largest target on a screen whose whole
          job is to slow the user down. */}
      <div className="flex flex-col gap-3">
        <div>
          <Button variant="destructive" onClick={onDelete} disabled={running || done}>
            <Trash2 data-icon="inline-start" className="size-4" />
            Delete all data
          </Button>
        </div>

        <DeleteStatus state={state} />
      </div>
    </>
  );
}

export function DataSection() {
  const [view, setView] = useState<DataView>('overview');

  return (
    <SettingsPane viewKey={view}>
      {view === 'overview' ? (
        <>
          <SettingsHeader
            title="Data"
            description="Your data syncs across your devices, end-to-end encrypted. Import, export, or delete all of it here."
          />

          <SyncStatus />

          <div className="flex flex-col gap-3">
            <SettingsRow
              icon={<Upload className="size-5" />}
              title="Import data"
              description="Add links from a text file or another app."
              onClick={() => setView('import')}
            />
            <SettingsRow
              icon={<Download className="size-5" />}
              title="Export all data"
              description="Save everything as a backup or bookmarks file."
              onClick={() => setView('export')}
            />
            <SettingsRow
              icon={<Trash2 className="size-5" />}
              title="Delete all data"
              description="Permanently remove all your data."
              onClick={() => setView('delete')}
              destructive
            />
          </div>
        </>
      ) : view === 'import' ? (
        <ImportView onBack={() => setView('overview')} />
      ) : view === 'export' ? (
        <ExportView onBack={() => setView('overview')} />
      ) : (
        <DeleteView onBack={() => setView('overview')} />
      )}
    </SettingsPane>
  );
}
