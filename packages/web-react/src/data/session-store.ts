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

export interface SessionRecord {
  // Public handle, kept for display/UX — not a secret.
  username: string;
  // Bearer token the API authenticates each request with.
  token: string;
  // Epoch ms when the token expires; lets the client pre-empt a stale request.
  expiresAt: number;
  // Non-extractable AES-256-GCM key for the user's data. Survives structured
  // clone with extractable=false intact.
  encryptionKey: CryptoKey;
}

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
// hit per request. The auth provider hydrates it once via loadSession() on load;
// saveSession / clearSession keep it in step.
let current: SessionRecord | null = null;

// The live session record (in-memory), or null. Exposes the non-extractable
// encryptionKey for the data layer; NOT expiry-gated (the key still decrypts
// cached data offline even after the bearer token has lapsed).
export function getSession(): SessionRecord | null {
  return current;
}

// The bearer token for the Authorization header, or null. Withheld once expired —
// sending a known-stale token would just earn a 401.
export function getToken(): string | null {
  if (!current || current.expiresAt <= Date.now()) return null;
  return current.token;
}

// "The active session is no longer valid" notifier. Fired by the api client when
// the server rejects our bearer token (401) or a request is attempted with an
// expired one; the auth provider subscribes and drops to signed-out. This keeps
// the api client a pure reader — it signals, it doesn't mutate session state. The
// provider stays the sole writer (saveSession/clearSession).
type SessionInvalidListener = () => void;
const invalidListeners = new Set<SessionInvalidListener>();

// Subscribe; returns an unsubscribe fn.
export function onSessionInvalid(listener: SessionInvalidListener): () => void {
  invalidListeners.add(listener);
  return () => invalidListeners.delete(listener);
}

// Notify subscribers — a pure fan-out. Deduping any reaction (e.g. collapsing a
// double sign-out from concurrent failing requests) is the subscriber's concern,
// not this passive store's; it owns the lifecycle being guarded.
export function notifySessionInvalid(): void {
  for (const listener of invalidListeners) listener();
}

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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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

// Persist (or replace) the current session. Updates the in-memory mirror first so
// synchronous readers see it immediately; the IndexedDB write is skipped
// off-browser (SSR), where there is no IndexedDB.
export async function saveSession(record: SessionRecord): Promise<void> {
  current = record;
  if (!hasIndexedDb()) return;
  await tx('readwrite', (s) => s.put(record, CURRENT));
}

// Read the persisted session into the in-memory mirror and return it. Called once
// by the auth provider on app load to hydrate; thereafter getSession/getToken read
// the mirror synchronously.
export async function loadSession(): Promise<SessionRecord | null> {
  if (!hasIndexedDb()) return current;
  current = (await tx<SessionRecord | undefined>('readonly', (s) => s.get(CURRENT))) ?? null;
  return current;
}

export async function clearSession(): Promise<void> {
  current = null;
  if (!hasIndexedDb()) return;
  await tx('readwrite', (s) => s.delete(CURRENT));
}
