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

import {
  formatSyncedAt,
  getSyncPhase,
  SYNC_PHASE_LABELS,
  syncBlockedDetail,
} from '@stxapps/shared';
import {
  type DeleteAllState,
  type ExportFormat,
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
  const { storeStatus, bgSyncStatus, lastSyncAt, lastError, blockedCount, requestSync } = useSync();
  const pendingCount = usePendingChangesCount();
  const phase = getSyncPhase(storeStatus, bgSyncStatus);
  // Rendered inside InitialSyncGate, so storeStatus is never 'error' here —
  // 'initial-error' and its retryInitialSync belong to the gate's own screen.
  const isError = phase === 'cycle-error';
  // The quota gate refused part of the push. Deliberately NOT styled as an
  // error: everything else synced and the local library is intact — what's
  // needed is some freed space, not a retry (which is also why it gets no Retry
  // button; pressing one would change nothing).
  const isBlocked = phase === 'capacity-blocked';

  const icon = isError ? (
    <CircleAlert className="size-4 text-destructive" />
  ) : isBlocked ? (
    <CircleAlert className="size-4 text-muted-foreground" />
  ) : phase === 'idle' ? (
    <CircleCheck className="size-4 text-muted-foreground" />
  ) : (
    <Loader2 className="size-4 animate-spin text-muted-foreground" />
  );

  const text =
    phase === 'idle' && lastSyncAt
      ? `Last synced ${formatSyncedAt(lastSyncAt)}`
      : SYNC_PHASE_LABELS[phase];
  const detail = phase === 'cycle-error' ? lastError : null;
  const action =
    phase === 'cycle-error'
      ? { label: 'Retry', onClick: requestSync }
      : phase === 'idle'
        ? { label: 'Sync now', onClick: requestSync }
        : null;

  return (
    <SettingsRow
      icon={<span className="mt-0.5 block">{icon}</span>}
      title={<span className="text-sm">Sync</span>}
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
          {/* Qualifies what a settled sync means: the INDEX is what syncs, so
              "Up to date" would otherwise read as "every byte is on this device"
              — but content (`files/`) downloads lazily on open (docs
              local-first-sync.md — metadata vs. content). Suppressed on an error,
              where a standing fact only competes with the failure message. */}
          {!isError && !isBlocked && (
            <span className="mt-1 text-xs text-muted-foreground">
              Saved page copies and images download when you open them.
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
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    const counts =
      state.done !== undefined && state.total !== undefined && state.total > 0
        ? ` (${state.done} of ${state.total})`
        : '';
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {IMPORT_STEP_LABELS[state.step]}
        {counts}
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
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
      <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>No links were found in that file.</span>
      </p>
    );
  }

  const created: string[] = [];
  if (outcome.listCount > 0) {
    created.push(`${outcome.listCount} ${outcome.listCount === 1 ? 'list' : 'lists'}`);
  }
  if (outcome.tagCount > 0) {
    created.push(`${outcome.tagCount} ${outcome.tagCount === 1 ? 'tag' : 'tags'}`);
  }
  const notes: string[] = [];
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
    <div className="mt-3 flex items-start gap-2 text-sm">
      <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
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

function ImportView({ onBack }: { onBack: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { state, run } = useImportAllData();
  const running = state.phase === 'running';

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
        description="Import from a file — a Bracemark backup (.zip), an HTML bookmarks file (web browsers, LinkWarden, Karakeep), a Pocket export (.zip or .csv), a Raindrop.io CSV, or a plain list of links. The format is detected automatically; links you already have are skipped. Large imports may take a few minutes."
      />
      <input
        ref={inputRef}
        type="file"
        accept=".zip,.html,.htm,.csv,.txt,text/html,text/csv,text/plain,application/zip"
        className="hidden"
        onChange={onFilePicked}
      />
      <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={running}>
        <Upload className="size-4" />
        Choose a file
      </Button>

      <ImportStatus state={state} />
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
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {EXPORT_STEP_LABELS[state.step]}
        {counts}
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
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
  return (
    <div className="mt-3 flex items-start gap-2 text-sm">
      <CircleCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground">
        Exported {outcome.linkCount} {outcome.linkCount === 1 ? 'link' : 'links'}
        {outcome.fileCount > 0
          ? ` and ${outcome.fileCount} ${outcome.fileCount === 1 ? 'file' : 'files'}`
          : ''}
        .{warnings.map((warning) => ` ${warning}`).join('')}
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
        description="Download a copy of your data to your device. Pick a format for where it’s going. This may take a few minutes for a large library."
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
              <span className="flex items-center gap-2 font-medium">
                {option.icon}
                {option.label}
              </span>
              <span className="text-sm font-normal text-muted-foreground">{option.hint}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>

      {lockedCount > 0 && (
        <SettingsNotice icon={<Lock className="size-4" />}>
          <span>
            {lockedCount} locked {lockedCount === 1 ? 'list' : 'lists'} — and the links inside{' '}
            {lockedCount === 1 ? 'it' : 'them'} — won&apos;t be included. Unlock{' '}
            {lockedCount === 1 ? 'it' : 'them'} first if you want everything.
          </span>
        </SettingsNotice>
      )}

      <div>
        <Button variant="outline" onClick={() => run(format, lockedListIds)} disabled={running}>
          <Download className="size-4" />
          Export all data
        </Button>
      </div>

      <ExportStatus state={state} excludedCount={lockedCount} />
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
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Deleting all your data…
      </p>
    );
  }

  if (state.phase === 'error') {
    return (
      <p className="mt-3 flex items-start gap-2 text-sm text-destructive">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span className="wrap-break-words">
          Delete failed: {state.message} Nothing was removed from this device — please try again.
        </span>
      </p>
    );
  }

  const { deletedCount } = state.outcome;
  return (
    <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
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
      <SettingsHeader back={{ label: 'Data', onClick: onBack }} title="Delete all data" />
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Delete all your data — every saved link in every list, all your lists and tags, and all
          your settings — from all your devices.
        </p>
        <p className="text-sm text-muted-foreground">
          This removes your data only, not your account — you can still sign in. If another device
          has changes that haven&apos;t synced yet, those changes may sync back afterward. Consider
          exporting a copy first.
        </p>
        <p className="text-sm font-medium text-destructive">This action cannot be undone.</p>
      </div>

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
        <span className="text-sm font-normal">
          Yes, I&apos;m absolutely sure I want to delete all my data.
        </span>
      </Label>

      {nudge && (
        <p className="mt-2 text-sm text-destructive">Please tick the box above to confirm.</p>
      )}

      <div>
        <Button variant="destructive" onClick={onDelete} disabled={running || done}>
          <Trash2 className="size-4" />
          Delete all data
        </Button>
      </div>

      <DeleteStatus state={state} />
    </>
  );
}

export function DataSection() {
  const [view, setView] = useState<DataView>('overview');

  return (
    <SettingsPane>
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
              description="Download everything as a backup or bookmarks file."
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
