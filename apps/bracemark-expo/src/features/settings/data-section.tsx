// The Data settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_data/data-section.tsx` (the canonical doc: sync
// status up top, then the three data-lifecycle actions — import / export /
// delete-all — as in-section VIEW STATE; the format matrix and dedup/quota
// policy live in docs/data-lifecycle.md). All three actions are real, over
// expo-react's useImportAllData / useExportAllData / useDeleteAllData.
// Platform divergences: import picks its file through expo-document-picker
// (web's hidden <input type=file>), and export hands the produced cache file
// to the platform SHARE SHEET (expo-sharing) — presented once when the run
// finishes, re-presentable from the receipt — where web downloads/streams to
// disk.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import {
  CircleAlert,
  CircleCheck,
  Download,
  FileText,
  Globe,
  Lock,
  type LucideIcon,
  Package,
  Sheet,
  Trash2,
  Upload,
} from 'lucide-react-native';

import {
  type DeleteAllState,
  type ExportedFile,
  type ExportFormat,
  type ExportState,
  type ImportState,
  useDeleteAllData,
  useExportAllData,
  useImportAllData,
  useLocks,
  usePendingChangesCount,
  useSync,
} from '@stxapps/expo-react';
import {
  formatSyncedAt,
  getSyncPhase,
  SYNC_PHASE_LABELS,
  syncBlockedDetail,
} from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Icon } from '../../components/ui/icon';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { SettingsHeader, SettingsPane, SettingsRow } from './settings-kit';

type DataView = 'overview' | 'import' | 'export' | 'delete';

// The sync status card: collapses the two sync dimensions into one phase
// (@stxapps/shared's getSyncPhase — the same derivation as web and the ⋯ menu)
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
    <Icon as={CircleAlert} className="size-4 text-destructive" />
  ) : isBlocked ? (
    <Icon as={CircleAlert} className="size-4 text-muted-foreground" />
  ) : phase === 'idle' ? (
    <Icon as={CircleCheck} className="size-4 text-muted-foreground" />
  ) : (
    <ActivityIndicator size="small" />
  );

  const text =
    phase === 'idle' && lastSyncAt
      ? `Last synced ${formatSyncedAt(lastSyncAt)}`
      : SYNC_PHASE_LABELS[phase];
  const detail = phase === 'cycle-error' ? lastError : null;
  const action =
    phase === 'cycle-error'
      ? { label: 'Retry', onPress: requestSync }
      : phase === 'idle'
        ? { label: 'Sync now', onPress: requestSync }
        : null;

  return (
    <View className="flex-row items-start justify-between gap-4 rounded-lg border border-border p-4">
      <View className="min-w-0 flex-1 flex-row items-start gap-2.5">
        <View className="mt-0.5 shrink-0">{icon}</View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-sm font-medium">Sync</Text>
          <Text className={cn('text-sm', isError ? 'text-destructive' : 'text-muted-foreground')}>
            {text}
          </Text>
          {detail && <Text className="text-sm text-destructive">{detail}</Text>}
          {/* The one place a blocked sync is explained. Inline rather than the
              hoisted paywall dialog: this is a STATUS the user came to read,
              not an action being interrupted (paywall-provider's header). No
              "See plans" button — the only refusal left is the storage ceiling,
              which upgrading a PLAN doesn't clear on a paid account and which
              the pricing page cannot help with. The fix is in the sentence. */}
          {isBlocked && (
            <Text className="text-sm text-muted-foreground">
              {syncBlockedDetail(phase, blockedCount)} Everything already saved is safe.
            </Text>
          )}
          {pendingCount > 0 && (
            <Text className="text-sm text-muted-foreground">
              {pendingCount} {pendingCount === 1 ? 'change' : 'changes'} waiting to sync
            </Text>
          )}
          {/* Qualifies what a settled sync means: the INDEX is what syncs, so
              content downloads lazily on open (docs/local-first-sync.md).
              Suppressed on an error, where it only competes with the failure. */}
          {!isError && !isBlocked && (
            <Text className="mt-1 text-xs text-muted-foreground">
              Saved page copies and images download when you open them.
            </Text>
          )}
        </View>
      </View>
      {action && (
        <Button variant="outline" size="sm" onPress={action.onPress}>
          <Text>{action.label}</Text>
        </Button>
      )}
    </View>
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
// errored — web's ImportStatus, verbatim in copy.
function ImportStatus({ state }: { state: ImportState }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    const counts =
      state.done !== undefined && state.total !== undefined && state.total > 0
        ? ` (${state.done} of ${state.total})`
        : '';
    return (
      <View className="mt-3 flex-row items-center gap-2">
        <ActivityIndicator size="small" />
        <Text className="text-sm text-muted-foreground">
          {IMPORT_STEP_LABELS[state.step]}
          {counts}
        </Text>
      </View>
    );
  }

  if (state.phase === 'error') {
    return (
      <View className="mt-3 flex-row items-start gap-2">
        <Icon as={CircleAlert} className="mt-0.5 size-4 shrink-0 text-destructive" />
        <Text className="min-w-0 flex-1 text-sm text-destructive">
          Import failed: {state.message}
        </Text>
      </View>
    );
  }

  const { outcome } = state;
  const nothingFound =
    outcome.linkCount === 0 && outcome.fileCount === 0 && outcome.skippedCount === 0;
  if (nothingFound) {
    return (
      <View className="mt-3 flex-row items-start gap-2">
        <Icon as={CircleAlert} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-sm text-muted-foreground">
          No links were found in that file.
        </Text>
      </View>
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
    <View className="mt-3 flex-row items-start gap-2">
      <Icon as={CircleCheck} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <Text className="min-w-0 flex-1 text-sm text-muted-foreground">
        Imported {outcome.linkCount} {outcome.linkCount === 1 ? 'link' : 'links'}
        {outcome.fileCount > 0
          ? ` and ${outcome.fileCount} ${outcome.fileCount === 1 ? 'file' : 'files'}`
          : ''}
        .{notes.map((note) => ` ${note}`).join('')}
      </Text>
    </View>
  );
}

// What the picker offers. Types are advisory on both platforms (Android treats
// them as a filter, iOS as UTI hints); the orchestrator sniffs the real format
// from the bytes anyway, so a permissive list just keeps pickable files broad.
const IMPORT_MIME_TYPES = ['application/zip', 'text/html', 'text/csv', 'text/plain'];

function ImportView({ onBack }: { onBack: () => void }) {
  const { state, run } = useImportAllData();
  const running = state.phase === 'running';

  const pick = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: IMPORT_MIME_TYPES,
      // Copy into the app's cache so the orchestrator reads a plain file:// uri
      // (a content:// or security-scoped uri needs no further ceremony).
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (asset) run({ uri: asset.uri, name: asset.name });
  };

  return (
    <View>
      <SettingsHeader
        title="Import data"
        description="Import from a file — a Bracemark backup (.zip), an HTML bookmarks file (web browsers, LinkWarden, Karakeep), a Pocket export (.zip or .csv), a Raindrop.io CSV, or a plain list of links. The format is detected automatically; links you already have are skipped. Large imports may take a few minutes."
        back={{ label: 'Data', onPress: onBack }}
      />
      <View className="mt-6 flex-row">
        <Button variant="outline" onPress={() => void pick()} disabled={running}>
          <Icon as={Upload} className="size-4" />
          <Text>Choose a file</Text>
        </Button>
      </View>

      <ImportStatus state={state} />
    </View>
  );
}

// The four export formats — web's EXPORT_FORMAT_OPTIONS, verbatim in copy
// (three destinations share the Netscape HTML serializer, so they're one
// option with the destinations named in its hint).
const EXPORT_FORMAT_OPTIONS: {
  value: ExportFormat;
  label: string;
  hint: string;
  icon: LucideIcon;
}[] = [
  {
    value: 'bracemark',
    label: 'Bracemark backup',
    hint: 'Everything — links, lists, tags, pins, files, and settings — as a .zip you can import back into Bracemark.',
    icon: Package,
  },
  {
    value: 'netscape',
    label: 'HTML bookmarks',
    hint: 'For web browsers (Chrome, Firefox, Safari), LinkWarden, and Karakeep. Links in Trash aren’t included.',
    icon: Globe,
  },
  {
    value: 'csv',
    label: 'CSV',
    hint: 'For Raindrop.io and spreadsheets. Links in Trash aren’t included.',
    icon: Sheet,
  },
  {
    value: 'text',
    label: 'Plain text',
    hint: 'Just the URLs, one per line — opens in any text editor.',
    icon: FileText,
  },
];

const EXPORT_STEP_LABELS: Record<'sync' | 'gather' | 'files' | 'assemble', string> = {
  sync: 'Refreshing from the server…',
  gather: 'Gathering links…',
  files: 'Downloading files…',
  assemble: 'Packaging…',
};

// Present the platform share sheet for the produced file — how a cache file
// becomes a saved/shared one on this platform (Files, iCloud, another app…).
async function shareExportedFile(file: ExportedFile): Promise<void> {
  await Sharing.shareAsync(file.uri, {
    mimeType: file.mimeType,
    dialogTitle: file.name,
  });
}

// The receipt under the export button: progress while running, the counts +
// any warnings + the save affordance when done, the failure when errored.
function ExportStatus({ state, excludedCount }: { state: ExportState; excludedCount: number }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    const counts =
      state.done !== undefined && state.total !== undefined && state.total > 0
        ? ` (${state.done} of ${state.total})`
        : '';
    return (
      <View className="mt-3 flex-row items-center gap-2">
        <ActivityIndicator size="small" />
        <Text className="text-sm text-muted-foreground">
          {EXPORT_STEP_LABELS[state.step]}
          {counts}
        </Text>
      </View>
    );
  }

  if (state.phase === 'error') {
    return (
      <View className="mt-3 flex-row items-start gap-2">
        <Icon as={CircleAlert} className="mt-0.5 size-4 shrink-0 text-destructive" />
        <Text className="min-w-0 flex-1 text-sm text-destructive">
          Export failed: {state.message}
        </Text>
      </View>
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
    <View className="mt-3">
      <View className="flex-row items-start gap-2">
        <Icon as={CircleCheck} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <Text className="min-w-0 flex-1 text-sm text-muted-foreground">
          Exported {outcome.linkCount} {outcome.linkCount === 1 ? 'link' : 'links'}
          {outcome.fileCount > 0
            ? ` and ${outcome.fileCount} ${outcome.fileCount === 1 ? 'file' : 'files'}`
            : ''}
          .{warnings.map((warning) => ` ${warning}`).join('')}
        </Text>
      </View>
      {/* Re-present the sheet — the auto-presented one may have been swiped
          away before picking a destination. */}
      <View className="mt-3 flex-row">
        <Button variant="outline" size="sm" onPress={() => void shareExportedFile(outcome.file)}>
          <Icon as={Download} className="size-4" />
          <Text>Save file…</Text>
        </Button>
      </View>
    </View>
  );
}

function ExportView({ onBack }: { onBack: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('bracemark');
  const { lockedListIds } = useLocks();
  const { state, run } = useExportAllData();
  const running = state.phase === 'running';
  const lockedCount = lockedListIds.size;

  // Present the share sheet once per completed run — the natural next step of
  // "Export" on this platform. Keyed by the produced file's uri so a re-run
  // re-presents; the receipt's "Save file…" covers a dismissed sheet.
  const presentedRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase !== 'done') return;
    if (presentedRef.current === state.outcome.file.uri) return;
    presentedRef.current = state.outcome.file.uri;
    void shareExportedFile(state.outcome.file).catch(() => {
      // Sharing unavailable/dismissed — the receipt's button remains.
    });
  }, [state]);

  return (
    <View>
      <SettingsHeader
        title="Export all data"
        description="Save a copy of your data. Pick a format for where it’s going. This may take a few minutes for a large library."
        back={{ label: 'Data', onPress: onBack }}
      />

      <RadioGroup
        value={format}
        onValueChange={(v) => setFormat(v as ExportFormat)}
        className="mt-6 gap-3"
      >
        {EXPORT_FORMAT_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            disabled={running}
            onPress={() => setFormat(option.value)}
            aria-checked={format === option.value}
            className={cn(
              'flex-row items-start gap-3 rounded-lg border border-border p-3',
              format === option.value && 'border-primary bg-muted/40',
            )}
          >
            <RadioGroupItem value={option.value} className="mt-0.5" />
            <View className="min-w-0 flex-1 gap-0.5">
              <View className="flex-row items-center gap-2">
                <Icon as={option.icon} className="size-4 text-foreground" />
                <Text className="font-medium">{option.label}</Text>
              </View>
              <Text className="text-sm text-muted-foreground">{option.hint}</Text>
            </View>
          </Pressable>
        ))}
      </RadioGroup>

      {lockedCount > 0 && (
        <View className="mt-4 flex-row items-start gap-2 rounded-lg border border-border p-3">
          <Icon as={Lock} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <Text className="min-w-0 flex-1 text-sm text-muted-foreground">
            {lockedCount} locked {lockedCount === 1 ? 'list' : 'lists'} — and the links inside{' '}
            {lockedCount === 1 ? 'it' : 'them'} — won&apos;t be included. Unlock{' '}
            {lockedCount === 1 ? 'it' : 'them'} first if you want everything.
          </Text>
        </View>
      )}

      <View className="mt-6 flex-row">
        <Button variant="outline" onPress={() => run(format, lockedListIds)} disabled={running}>
          <Icon as={Download} className="size-4" />
          <Text>Export all data</Text>
        </Button>
      </View>

      <ExportStatus state={state} excludedCount={lockedCount} />
    </View>
  );
}

// The one-line receipt under the delete button: a single spinner while running
// (the wipe is one server call — no per-item progress to show), the count when
// done, the failure when errored (the endpoint is idempotent, so the retry is
// just tapping again).
function DeleteStatus({ state }: { state: DeleteAllState }) {
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    return (
      <View className="mt-3 flex-row items-center gap-2">
        <ActivityIndicator size="small" />
        <Text className="text-sm text-muted-foreground">Deleting all your data…</Text>
      </View>
    );
  }

  if (state.phase === 'error') {
    return (
      <View className="mt-3 flex-row items-start gap-2">
        <Icon as={CircleAlert} className="mt-0.5 size-4 shrink-0 text-destructive" />
        <Text className="min-w-0 flex-1 text-sm text-destructive">
          Delete failed: {state.message} Nothing was removed from this device — please try again.
        </Text>
      </View>
    );
  }

  const { deletedCount } = state.outcome;
  return (
    <View className="mt-3 flex-row items-start gap-2">
      <Icon as={CircleCheck} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <Text className="min-w-0 flex-1 text-sm text-muted-foreground">
        {deletedCount === 0
          ? 'There was no data to delete.'
          : `All your data has been deleted (${deletedCount} ${deletedCount === 1 ? 'item' : 'items'}).`}
      </Text>
    </View>
  );
}

function DeleteView({ onBack }: { onBack: () => void }) {
  const { state, run } = useDeleteAllData();
  const [confirmed, setConfirmed] = useState(false);
  // Reveal the "tick the box first" nudge only after a tap without the box.
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
    <View>
      <SettingsHeader
        title="Delete all data"
        description="Delete all your data — every saved link in every list, all your lists and tags, and all your settings — from all your devices."
        back={{ label: 'Data', onPress: onBack }}
      />
      <Text className="mt-3 text-sm text-muted-foreground">
        This removes your data only, not your account — you can still sign in. If another device has
        changes that haven&apos;t synced yet, those changes may sync back afterward. Consider
        exporting a copy first (Settings → Data).
      </Text>
      <Text className="mt-3 text-sm font-medium text-destructive">
        This action cannot be undone.
      </Text>

      <Pressable
        className="mt-6 flex-row items-start gap-3 rounded-lg border border-border p-3"
        onPress={() => {
          if (running || done) return;
          setConfirmed((v) => !v);
          setNudge(false);
        }}
      >
        <Checkbox
          checked={confirmed}
          disabled={running || done}
          onCheckedChange={(v) => {
            setConfirmed(v === true);
            setNudge(false);
          }}
          className="mt-0.5"
        />
        <Text className="min-w-0 flex-1 text-sm">
          Yes, I&apos;m absolutely sure I want to delete all my data.
        </Text>
      </Pressable>

      {nudge && (
        <Text className="mt-2 text-sm text-destructive">Please tick the box above to confirm.</Text>
      )}

      <View className="mt-6 flex-row">
        <Button variant="destructive" onPress={onDelete} disabled={running || done}>
          <Icon as={Trash2} className="size-4" />
          <Text>Delete all data</Text>
        </Button>
      </View>

      <DeleteStatus state={state} />
    </View>
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

          <View className="gap-3">
            <SettingsRow
              icon={<Icon as={Upload} className="size-5 text-muted-foreground" />}
              title="Import data"
              description="Add links from a text file or another app."
              onPress={() => setView('import')}
            />
            <SettingsRow
              icon={<Icon as={Download} className="size-5 text-muted-foreground" />}
              title="Export all data"
              description="Save everything as a backup or bookmarks file."
              onPress={() => setView('export')}
            />
            <SettingsRow
              icon={<Icon as={Trash2} className="size-5 text-destructive" />}
              title="Delete all data"
              description="Permanently remove all your data."
              onPress={() => setView('delete')}
              destructive
            />
          </View>
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
