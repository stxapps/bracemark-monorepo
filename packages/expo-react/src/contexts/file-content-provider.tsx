// On-demand `files/` content for the UI — the expo port of web-react's
// contexts/file-content-provider (that header is canonical: why sync never
// downloads content, mounting as the display signal, the micro-batching and
// per-id single-flight, the session-long missing memo and why it's safe, the
// transport-failure retry). One call:
//
//   requestFileContent(fileId) — "a mounted view wants this blob resident".
//
// Platform divergences:
//  - The fetch materializes a DECRYPTED file on disk (engine loadEntityContents
//    → BracemarkFileCrypto, file-store.ts) and flags the row's `hasDataFile`, not
//    bytes into a Dexie record — the requesting view observes the landing via
//    useLiveRead over `items` (markItemDataFile touches the row) and re-reads
//    the plaintext uri (readFileUri).
//  - `encryptionKey` is the session's raw key bytes (see expo-crypto), built
//    into SyncDeps the same way SyncProvider does.

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
  // Ask for a `files/{fileId}.enc` blob to be fetched, decrypted to disk, and
  // flagged on its row. Fire-and-forget: observe the uri reactively
  // (readFileUri via useLiveRead — useImageFileUri does both halves).
  // Duplicate and known-missing ids are no-ops.
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
  // batch settles: a successful fetch leaves the plaintext on disk (so nothing
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
