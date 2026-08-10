'use client';

// On-demand `files/` content for the UI — the seam that lets a rendered row pull
// a lazy image blob without owning SyncDeps. Sync deliberately never downloads
// content (docs/local-first-sync.md: metadata eager, content lazy); the engine's
// loadEntityContent(s) is the sanctioned fetch path, but it needs the session key
// + api client, which no component holds. This provider builds those the way
// SyncProvider does (useAuth + getSession + useApiClient) and exposes one call:
//
//   requestFileContent(fileId) — "a mounted view wants this blob resident".
//
// The caller doesn't await it: the fetch decrypts into Dexie (`db.items.data`),
// and the requesting view's liveQuery repaints when the bytes land. Mounting is
// the display signal — rows are virtualized, so a row asking on mount is exactly
// "scrolled into view" (useImageFileUrl adds a settle delay so a fast scroll
// doesn't request every row it flies past).
//
// Requests are MICRO-BATCHED: ids queue for FLUSH_DELAY_MS, then one
// loadEntityContents call fetches the batch — one `files/sign` round trip per
// flush (~a page of images) instead of one per image, with the engine's own
// download fan-out and retry underneath. Per-id single-flight while queued or in
// flight; ids that come back MISSING (no local record, or deleted server-side —
// a 404 on GET) are remembered for the session and never re-requested, so a
// dangling ref can't re-buy a sign+GET on every remount. That memory is safe
// because a files/ record always exists locally before anything references it
// (sync stores content records before the index entities that point at them, and
// local extraction writes the bytes outright) — a session-long block only ever
// covers a genuinely deleted blob. A TRANSPORT failure is the opposite: the
// batch is forgotten so a later mount retries.
//
// NOT gated on the serverExtraction opt-in (unlike ExtractionProvider): this is
// ordinary sync-engine traffic to our own R2 — the user's own encrypted bytes —
// not a third-party fetch.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import { useApiClient } from '@stxapps/react';
import { FILES_PREFIX, pathFromId } from '@stxapps/shared';

import { getSession } from '../data/session-store';
import { loadEntityContents, type SyncDeps } from '../sync/engine';
import { useAuth } from './auth-provider';

// How long requests pool before a flush. Long enough to gather a page of rows
// mounting together (one sign call for all of them), short enough to be
// imperceptible on top of the hook's own settle delay.
const FLUSH_DELAY_MS = 150;

interface FileContentContextValue {
  // Ask for a `files/{fileId}.enc` blob to be fetched, decrypted, and stored in
  // Dexie. Fire-and-forget: observe the bytes reactively (readFileBytes via
  // liveQuery — useImageFileUrl does both halves). Duplicate and known-missing
  // ids are no-ops.
  requestFileContent: (fileId: string) => void;
}

const FileContentContext = createContext<FileContentContextValue | null>(null);

export function FileContentProvider({ children }: { children: ReactNode }) {
  const { username } = useAuth();
  const api = useApiClient();

  // Latest identities for the async drain, so a flush started before a render
  // never fetches with a stale api client or a signed-out username.
  const usernameRef = useRef(username);
  usernameRef.current = username;
  const apiRef = useRef(api);
  apiRef.current = api;

  const queueRef = useRef<string[]>([]);
  // Queued or in flight — the single-flight guard. Cleared per id after its
  // batch settles: a successful fetch leaves the bytes in Dexie (so nothing
  // re-requests), and clearing keeps a later legitimate re-request possible.
  const handledRef = useRef(new Set<string>());
  // Known absent this session (no local record / deleted server-side).
  const missingRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drainingRef = useRef(false);

  // A different account's ids mean nothing here — drop the session-scoped memory.
  useEffect(() => {
    queueRef.current = [];
    handledRef.current.clear();
    missingRef.current.clear();
  }, [username]);

  const drain = useCallback(async () => {
    if (drainingRef.current) return; // the running loop picks up new queue entries
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const ids = queueRef.current.splice(0);
        const session = getSession();
        const name = usernameRef.current;
        if (!name || !session) {
          // No usable session (signing out / mirror not hydrated): drop the
          // batch but forget the ids so a signed-in remount can re-ask.
          for (const id of ids) handledRef.current.delete(id);
          return;
        }
        const deps: SyncDeps = {
          username: name,
          encryptionKey: session.encryptionKey,
          api: apiRef.current,
        };
        const idByPath = new Map(ids.map((id) => [pathFromId(id, FILES_PREFIX), id]));
        try {
          const { missingPaths } = await loadEntityContents(deps, [...idByPath.keys()]);
          for (const path of missingPaths) {
            const id = idByPath.get(path);
            if (id !== undefined) missingRef.current.add(id);
          }
        } catch {
          // Wholesale transport failure (already retried inside the engine).
          // Nothing was learned about these ids — forget them so a later mount
          // retries, and stop draining rather than hammering a dead network.
          for (const id of ids) handledRef.current.delete(id);
          return;
        }
        for (const id of ids) handledRef.current.delete(id);
      }
    } finally {
      drainingRef.current = false;
    }
  }, []);

  const requestFileContent = useCallback(
    (fileId: string) => {
      if (handledRef.current.has(fileId) || missingRef.current.has(fileId)) return;
      handledRef.current.add(fileId);
      queueRef.current.push(fileId);
      if (timerRef.current === null) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void drain();
        }, FLUSH_DELAY_MS);
      }
    },
    [drain],
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const value = useMemo<FileContentContextValue>(
    () => ({ requestFileContent }),
    [requestFileContent],
  );

  return <FileContentContext.Provider value={value}>{children}</FileContentContext.Provider>;
}

export function useFileContent(): FileContentContextValue {
  const ctx = useContext(FileContentContext);
  if (!ctx) throw new Error('useFileContent must be used within <FileContentProvider>');
  return ctx;
}
