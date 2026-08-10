import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LoaderCircle, SettingsIcon } from 'lucide-react';

import { normalizeUrl, TRASH_ID } from '@stxapps/shared';
import { type LinkItem, readLinkByUrlKey, useAuth, useSync } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { Complete } from './Complete';
import { Editor } from './Editor';
import { PopupMessage, PopupShell } from './Shell';
import { SignIn } from './SignIn';
import { SyncDetail, SyncPill } from './Sync';

// The active tab the popup is acting on. `null` once we know there's no usable tab
// (e.g. a chrome:// page the extension can't save); `undefined` while still loading.
export interface ActiveTab {
  url: string;
  title: string;
  // The tab's own favicon URL, as the browser already resolved it. Free here and
  // nowhere else: the popup is standing on the live page, so the specimen can
  // show a real icon without web-react's favicon fetch — which would go out over
  // the network, and only after the link is saved.
  iconUrl?: string;
}

// One spinner for every "we don't know yet" in the popup. Quiet on purpose —
// these resolve in tens of milliseconds, and a skeleton of a form that is about
// to appear reads as slower than a still mark does.
function Loading() {
  return (
    <PopupMessage>
      <LoaderCircle
        className={cn('size-4 animate-spin text-muted-foreground motion-reduce:animate-none')}
        aria-hidden="true"
      />
      <span className={cn('sr-only')}>Loading</span>
    </PopupMessage>
  );
}

// The popup is a tiny in-memory state machine — no router needed. The branch is
// driven by auth status and an "is this tab already saved?" live query:
//   loading → (signed out) signin → (signed in) editor → complete.
// If the active URL is already in the local store, we skip the editor and open the
// complete page straight away (covers reopening a saved tab, and the bonus path of
// opening a web-app-saved link then clicking the icon). A match in TRASH is the
// exception — see SaveFlow.
function App() {
  const { status } = useAuth();

  if (status === 'loading') {
    return (
      <PopupShell>
        <Loading />
      </PopupShell>
    );
  }
  if (status !== 'authenticated') return <SignIn />;
  return <AuthedApp />;
}

// Two parts, one tiny in-popup router: the save flow, with a glanceable sync pill
// docked under it. Clicking the pill swaps the whole popup to the sync detail view
// (and back) — sync detail lives in the popup, not Settings, so this is a local
// `view` toggle rather than opening the options page.
function AuthedApp() {
  const { requestSync } = useSync();
  const [view, setView] = useState<'flow' | 'sync'>('flow');

  // Kick a background cycle the moment the popup is authenticated. This subtree
  // mounts on BOTH entry paths — "opened while already signed in" (loading →
  // authenticated) and "just signed in" (unauthenticated → authenticated, App
  // swaps SignIn for this) — so one mount effect covers both. Without it a fresh
  // sign-in runs no cycle until the hourly alarm, leaving status at "last sync
  // never" over an empty store. `requestSync` messages the background (KICK_SYNC);
  // the worker's single-flight coalesces this with any alarm/startup cycle, so an
  // extra kick per popup open is cheap. This is the "KICK_SYNC from the popup"
  // freshness trigger background.ts anticipates, now wired beyond post-write.
  useEffect(() => {
    requestSync();
  }, [requestSync]);

  if (view === 'sync') return <SyncDetail onBack={() => setView('flow')} />;

  return (
    <PopupShell
      actions={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Settings"
          title="Settings"
          onClick={() => browser.runtime.openOptionsPage()}
        >
          <SettingsIcon className={cn('size-4')} />
        </Button>
      }
      footer={<SyncPill onClick={() => setView('sync')} />}
    >
      <SaveFlow />
    </PopupShell>
  );
}

function SaveFlow() {
  // `undefined` = still querying the active tab; `null` = no usable (http/https) tab.
  const [tab, setTab] = useState<ActiveTab | null | undefined>(undefined);
  // Set the moment a save completes, so we flip to the complete page without waiting
  // on the live "already saved?" query to catch up.
  const [justSaved, setJustSaved] = useState<LinkItem | null>(null);

  useEffect(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([active]) => {
        const url = active?.url ?? '';
        // Only http/https pages can be saved/extracted (no chrome://, web store, …).
        setTab(
          /^https?:/.test(url)
            ? { url, title: active?.title ?? '', iconUrl: active?.favIconUrl }
            : null,
        );
      })
      .catch(() => {
        setTab(null);
      });
  }, []);

  const normalizedUrl = tab ? (normalizeUrl(tab.url) ?? '') : '';
  // Live: re-renders if a background sync pulls in a matching saved link. Matched
  // by canonical identity (readLinkByUrlKey), not exact string, so a tab that
  // differs from the saved link only by scheme/www/trailing slash/query order
  // still counts as already saved.
  // The `?? null` is load-bearing: the query returns `undefined` for "not saved",
  // but useLiveQuery also returns `undefined` while it's still resolving. Coercing the
  // settled not-found case to `null` keeps `undefined` meaning ONLY "still loading" —
  // without it the guard below would treat every unsaved tab as perpetually loading.
  const existing = useLiveQuery(
    () =>
      (normalizedUrl ? readLinkByUrlKey(normalizedUrl) : Promise.resolve(undefined)).then(
        (link) => link ?? null,
      ),
    [normalizedUrl],
  );

  if (tab === undefined || existing === undefined) return <Loading />;
  if (tab === null) {
    // Names the boundary and what to do about it, rather than reporting a
    // refusal: "can't be saved" alone leaves the user re-clicking the icon on a
    // settings page wondering what broke.
    return (
      <PopupMessage>
        <p className={cn('text-sm font-medium')}>Nothing to save here</p>
        <p className={cn('text-xs leading-5 text-muted-foreground')}>
          Bracemark saves web pages. Open an http or https page and click the icon again.
        </p>
      </PopupMessage>
    );
  }

  // A match in Trash is NOT "already saved": the user removed it, and bracemark-web
  // hides Trash from every view except Trash itself (use-links), so Complete's
  // saved state would point at something they can't find. Falling through to a plain
  // Editor is no better — Save would mint a live copy shadowing the trashed one,
  // and readLinkByUrlKey (a `.first()` on the index) would then return an arbitrary
  // one of the two. So the editor takes the match and offers Restore instead.
  const link = justSaved ?? existing;
  if (link && link.listId !== TRASH_ID) return <Complete link={link} tab={tab} />;
  return (
    <Editor
      tab={tab}
      url={normalizedUrl || tab.url}
      trashed={link ?? undefined}
      onSaved={setJustSaved}
    />
  );
}

export default App;
