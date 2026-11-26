'use client';

// The main pane: reads the paginated link query once and hands it to whichever
// layout the user picked in Settings → Appearance (useSettings.linksLayout). Each layout
// owns its own scroll/virtualization, so this is a thin switch — it's the single
// place the data hook meets the layouts. It also mounts the bulk-edit toolbar
// (shown while the topbar's toggle holds `bulkEditing`) and the page-level
// dialogs the row menus + toolbar drive through view-state-provider (edit /
// bulk tags / move to / delete-permanently): one instance each, OUTSIDE the
// virtualized rows, so a sync repaint can never unmount them mid-interaction.
//
// A LOCKED selected list swaps the whole body for the lock pane BEFORE the data
// hook mounts (UnlockedMain is a separate component precisely so useLinks never
// runs while locked): the locked list's links are neither read nor rendered.
// Deep links that merely INCLUDE a locked list (?list-any=…, tags, search) don't
// swap — their queries exclude the locked links instead (use-links).

import { useEffect, useState } from 'react';

import { useEntitlements, useLocks, useSettings } from '@stxapps/web-react';
import { useElementWidth } from '@stxapps/web-ui/hooks/use-element-size';

import { BulkEditToolbar } from '../_components/bulk-edit-toolbar';
import { BulkTagsDialog } from '../_components/bulk-tags-dialog';
import { LinkDestroyConfirm } from '../_components/link-destroy-confirm';
import { LinkEditDialog } from '../_components/link-edit-dialog';
import { LinkMoveSurface } from '../_components/link-move-surface';
import { ListLockPane } from '../_components/list-lock-pane';
import { useLinksPage } from '../_contexts/page-provider';
import { useLinksViewState } from '../_contexts/view-state-provider';
import { useLinks } from '../_hooks/use-links';
import { CardLayout } from '../_layouts/card-layout';
import { ListLayout } from '../_layouts/list-layout';
import { resolveLayout } from '../_layouts/resolve-layout';
import { type LinkLayoutProps, useRootScale } from '../_layouts/shared';
import { TableLayout } from '../_layouts/table-layout';

type Layout = (props: LinkLayoutProps) => React.ReactNode;

// Keyed by the persisted `linksLayout` string rather than by `LinksLayout`, and the
// value is `| undefined`, because the setting is SYNCED: a device on a newer client
// can store a layout this build doesn't implement (see LINKS_LAYOUTS in entities.ts),
// and `useSettings` hands that value through untouched instead of rewriting it. So
// the lookup can miss, and `UnlockedMain` falls back rather than rendering nothing.
const LAYOUTS: Record<string, Layout | undefined> = {
  list: ListLayout,
  card: CardLayout,
  table: TableLayout,
};

export function Main() {
  const { selection } = useLinksPage();
  const { isListLocked } = useLocks();

  if (selection.kind === 'list' && isListLocked(selection.id)) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          {/* Keyed by the list: one locked list straight to another is a
              different lock, and the one instance used to serve both — the
              second pane opened holding the password typed for the first. */}
          <ListLockPane key={selection.id} listId={selection.id} />
        </div>
      </main>
    );
  }

  return <UnlockedMain />;
}

function UnlockedMain() {
  const { linksLayout } = useSettings();
  const { entitlements } = useEntitlements();
  // The resolved sort is intrinsic to the query (page-provider), so read it off
  // the same context the reads run through and hand it to the layout's date column.
  const { query } = useLinksPage();
  const { links, pinnedCount, hasMore, showMore, isLoading, hasPending, applyPending } = useLinks();
  const [pane, setPane] = useState<HTMLDivElement | null>(null);
  const paneWidth = useElementWidth(pane);
  const rootScale = useRootScale();

  // An unknown layout (synced from a client that has one we don't) renders as the
  // dense default — the same thing a user with no choice made sees. Deliberately does
  // NOT write the fallback back: the stored value stays whatever the other device
  // chose, so it still applies there. Settings → Appearance shows no selected radio while
  // this is in effect, which is the user's cue that the choice lives elsewhere. The
  // table's own fallbacks are resolveLayout's.
  const rendered = resolveLayout(linksLayout, entitlements.tableLayout, paneWidth, rootScale);
  const Layout = LAYOUTS[rendered] ?? ListLayout;

  // Tell View options when the list is standing in for a table only because the
  // pane is too narrow (not for a missing entitlement: Settings shows the plan
  // badge for that). Cleared on unmount — a locked list swaps this pane out.
  const { setTableTooNarrow } = useLinksViewState();
  const tableTooNarrow =
    linksLayout === 'table' && entitlements.tableLayout && rendered !== 'table';
  useEffect(() => {
    setTableTooNarrow(tableTooNarrow);
  }, [tableTooNarrow, setTableTooNarrow]);
  useEffect(() => () => setTableTooNarrow(false), [setTableTooNarrow]);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <BulkEditToolbar links={links} />
      <div ref={setPane} className="min-h-0 flex-1">
        <Layout
          links={links}
          sortOn={query.sortOn}
          pinnedCount={pinnedCount}
          hasMore={hasMore}
          showMore={showMore}
          isLoading={isLoading}
          hasPending={hasPending}
          applyPending={applyPending}
        />
      </div>
      <LinkEditDialog />
      <BulkTagsDialog />
      <LinkMoveSurface />
      <LinkDestroyConfirm />
    </main>
  );
}
