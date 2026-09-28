'use client';

// Client-only session store backed by IndexedDB. The active session — including
// the non-extractable AES `encryptionKey` — is persisted here so a page reload
// doesn't force the user back through the password + Argon2id derivation.
//
// Why IndexedDB and not localStorage: the `encryptionKey` is a non-extractable
// CryptoKey, so its raw bytes can't be serialized to a string; IndexedDB stores
// the CryptoKey itself (structured clone) and returns it still non-extractable.
// Keeping the whole record in one store also stops the token and key from drifting
// out of sync across two backends. See docs/account.md "client-side resilience".
//
// SECURITY: the `token` is a bearer credential readable by any JS on this origin
// (XSS exposure — the same as localStorage). The non-extractable key limits an
// attacker to in-page use, not exfiltration; a strong CSP is the real mitigation.
//
// ⚠ NO EXPIRY LIVES HERE, and none may be added (docs/sessions.md). The server
// decides a session's lifetime and says so with a code; a client that reads a
// deadline off its own clock is a client that wipes a user's only copy the day
// the server stops answering. The record carries a STATE the server's verdicts
// set, never a time.

import { newSessionGeneration, type SessionState, type SessionVerdict } from '@stxapps/shared';

import { isVersionError, markUpdateRequired } from './update-required';

export interface SessionRecord {
  // Public handle, kept for display/UX — not a secret.
  username: string;
  // Bearer token the API authenticates each request with.
  token: string;
  // Non-extractable AES-256-GCM key for the user's data. Survives structured
  // clone with extractable=false intact.
  encryptionKey: CryptoKey;
  // 'active', or 'expired' once the server answered this token
  // `session_expired`/`session_unknown`: the library stays fully usable, sync
  // pauses, and a sign-in with the same username resumes it.
  state: SessionState;
  // Which adopted token this is — minted by sign-in, create-account and resume.
  // Every request captures it with the token, and a verdict only applies if it
  // still matches the persisted record, so a slow response for a replaced token
  // can never expire or erase the session that replaced it. Local only: never
  // sent to the server, never in a notification alongside the token.
  generation: string;
}

// What sign-in / create-account hand the provider: the credential material. The
// provider mints the generation and the state when it adopts it.
export type SessionCredentials = Pick<SessionRecord, 'username' | 'token' | 'encryptionKey'>;

// Sibling of Dexie's 'bracemark-data' (db.ts) — deliberately a SEPARATE database:
// this one is hand-rolled raw IDB for auth/key material; Dexie owns its own
// schema/versioning over there.
const DB_NAME = 'bracemark-session';
const DB_VERSION = 1;
const STORE = 'session';
// One active session at a time, stored under a fixed key.
const CURRENT = 'current';

// In-memory mirror of the persisted session so synchronous consumers — chiefly
// the api client's auth header — can read the token without an async IndexedDB
// hit per request. The auth provider hydrates it via loadSession() on load and
// re-reads it whenever another context says the record changed;
// saveSession / clearSession keep it in step.
let current: SessionRecord | null = null;

// The live session record (in-memory), or null. Exposes the non-extractable
// encryptionKey for the data layer — in either state: an expired session still
// decrypts this device's library.
export function getSession(): SessionRecord | null {
  return current;
}

// The bearer token for the Authorization header, or null when signed out. Sent
// in the expired state too: the probe needs it, and any request it rides on can
// only earn another verdict for this same generation.
export function getToken(): string | null {
  return current?.token ?? null;
}

// --- verdicts ------------------------------------------------------------------

// A server verdict on the token of one generation. Fired by the api client when a
// request it AUTHENTICATED is answered with one of our session codes; the auth
// provider subscribes and decides — under the lifecycle lock, against the
// persisted generation — whether it still applies. This keeps the api client a
// pure reader: it signals, it never mutates session state.
export interface SessionVerdictEvent {
  verdict: SessionVerdict;
  generation: string;
}
type SessionVerdictListener = (event: SessionVerdictEvent) => void;
const verdictListeners = new Set<SessionVerdictListener>();

// Subscribe; returns an unsubscribe fn.
export function onSessionVerdict(listener: SessionVerdictListener): () => void {
  verdictListeners.add(listener);
  return () => verdictListeners.delete(listener);
}

// Notify subscribers — a pure fan-out. Deduping (a burst of concurrent failing
// requests) is the subscriber's concern: it owns the lifecycle being guarded.
export function notifySessionVerdict(event: SessionVerdictEvent): void {
  for (const listener of verdictListeners) listener(event);
}

// --- cross-context coordination -----------------------------------------------
//
// Every tab of the web app, and the browser extension's popup, options page and
// background worker, share one session record and one data database per origin.
// Each keeps its own in-memory mirror, so a change one context persists has to be
// ANNOUNCED to the others (docs/sessions.md, _concurrent requests and shared local
// state_). The announcement is a wake-up, not the truth: a receiver re-reads the
// record. It never carries the token.

export interface SessionChangeMessage {
  // The generation now persisted, or null once signed out.
  generation: string | null;
  // Why a signed-out change happened, so another tab can explain it too.
  reason?: 'signed-out' | 'revoked';
}

const CHANNEL_NAME = 'bracemark-session';
let channel: BroadcastChannel | null = null;
const changeListeners = new Set<(message: SessionChangeMessage) => void>();

function sessionChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    // Node's BroadcastChannel (the test runner) would otherwise hold the process
    // open; browsers have no unref and need none.
    (channel as BroadcastChannel & { unref?: () => void }).unref?.();
    channel.onmessage = (event: MessageEvent<SessionChangeMessage>) => {
      for (const listener of changeListeners) listener(event.data);
    };
  }
  return channel;
}

// Tell every OTHER context sharing this origin's session that the record changed.
// (A BroadcastChannel never delivers to its own sender.)
export function publishSessionChange(message: SessionChangeMessage): void {
  sessionChannel()?.postMessage(message);
}

// Subscribe to other contexts' changes; returns an unsubscribe fn.
export function onSessionChange(listener: (message: SessionChangeMessage) => void): () => void {
  sessionChannel();
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

// The LIFECYCLE LOCK. Adopting a session, resuming, expiring, and every teardown
// run under it, so two contexts can't interleave a wipe with a sign-in, and each
// re-reads the record after acquiring it — the decision is made against what is
// persisted then, not against what this context last saw. Web Locks span every
// context of the origin (tabs, the browser extension's pages and worker); where
// they're missing (tests, very old engines) an in-context queue still serializes
// this context's own transitions. NOT re-entrant: never take it inside itself.
const LOCK_NAME = 'bracemark-session-lifecycle';
let localQueue: Promise<unknown> = Promise.resolve();

export function withSessionLock<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) return locks.request(LOCK_NAME, run) as Promise<T>;
  const next = localQueue.then(run, run);
  localQueue = next.catch(() => undefined);
  return next;
}

// --- persistence --------------------------------------------------------------

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

// One connection for the app's lifetime — reopening per call is wasteful and the
// upgrade only needs to run once.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // ⚠ A newer build is opening this database at a higher version. Raw
        // IndexedDB never closes a connection by itself, so without this the NEW
        // tab's loadSession() blocks behind us and its auth never resolves. Close
        // now — no dialog first, which would hold the upgrade hostage — and
        // report (update-required.ts). This handler must already be in the build
        // being replaced; see that file.
        db.onversionchange = () => {
          db.close();
          markUpdateRequired('session');
        };
        resolve(db);
      };
      req.onerror = () => {
        // The database was already upgraded by a newer build before this tab
        // ever opened it: no versionchange will come, so report the same way.
        if (isVersionError(req.error)) markUpdateRequired('session');
        reject(req.error);
      };
    });
    // A failed open must not be cached: the next caller tries again.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

// Run one transaction and resolve when it COMMITS (oncomplete), not merely when
// the request succeeds — so a write is durable before the caller proceeds.
async function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    const fail = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = fail;
    transaction.onabort = fail;
  });
}

// A persisted row as it may sit on a device: a record from before the session
// redesign has an `expiresAt` and no state or generation.
type StoredRecord = Omit<SessionRecord, 'state' | 'generation'> &
  Partial<Pick<SessionRecord, 'state' | 'generation'>> & { expiresAt?: unknown };

// Normalize what was read: a pre-redesign row reads as ACTIVE — whatever its old
// `expiresAt` says, which is dropped unread — with an empty generation the
// lifecycle owner assigns (and persists) under the lock. Never "corrupt": a
// developer's device must not be signed out by an upgrade.
function fromStored(stored: StoredRecord | undefined): SessionRecord | null {
  if (!stored) return null;
  return {
    username: stored.username,
    token: stored.token,
    encryptionKey: stored.encryptionKey,
    state: stored.state === 'expired' ? 'expired' : 'active',
    generation: typeof stored.generation === 'string' ? stored.generation : '',
  };
}

// Persist (or replace) the current session. Updates the in-memory mirror first so
// synchronous readers see it immediately; the IndexedDB write is skipped
// off-browser (SSR), where there is no IndexedDB. Only the record's own fields
// are written, so a legacy `expiresAt` never survives a save.
export async function saveSession(record: SessionRecord): Promise<void> {
  const clean: SessionRecord = {
    username: record.username,
    token: record.token,
    encryptionKey: record.encryptionKey,
    state: record.state,
    generation: record.generation,
  };
  current = clean;
  if (!hasIndexedDb()) return;
  await tx('readwrite', (s) => s.put(clean, CURRENT));
}

// Read the persisted session WITHOUT touching the mirror — for a check that must
// compare against the truth (a verdict, a sync fence) rather than adopt it.
export async function peekSession(): Promise<SessionRecord | null> {
  if (!hasIndexedDb()) return current;
  return fromStored(await tx<StoredRecord | undefined>('readonly', (s) => s.get(CURRENT)));
}

// Read the persisted session into the in-memory mirror and return it. Called by
// the auth provider on load and on every cross-context wake-up, and by the
// browser extension's background worker before each trigger; thereafter
// getSession/getToken read the mirror synchronously. Throws on a failed read —
// which is NOT "signed out" and must never be treated as permission to clear.
export async function loadSession(): Promise<SessionRecord | null> {
  if (!hasIndexedDb()) return current;
  current = await peekSession();
  return current;
}

export async function clearSession(): Promise<void> {
  current = null;
  if (!hasIndexedDb()) return;
  await tx('readwrite', (s) => s.delete(CURRENT));
}

// Mint the persisted form of freshly adopted credentials.
export function activeRecord(credentials: SessionCredentials): SessionRecord {
  return { ...credentials, state: 'active', generation: newSessionGeneration() };
}
