// Client-only session store backed by expo-secure-store — the platform:expo
// sibling of web-react's data/session-store.ts. The active session — including
// the raw AES `encryptionKey` bytes — is persisted here so an app relaunch
// doesn't force the user back through the password + Argon2id derivation.
//
// Why secure-store and not sqlite/file-system: native has no non-extractable
// CryptoKey handle (see expo-crypto's Account), so at-rest protection must come
// from the storage itself — secure-store is Keychain (iOS) / Keystore-encrypted
// SharedPreferences (Android); sqlite and file-system are plain files. Keeping
// the whole record in one entry also stops the token and key from drifting out
// of sync across two backends — the same one-record invariant as web-react's
// single IDB store. The record is a few hundred bytes, well under secure-store's
// ~2 KB Android advisory limit.
//
// SECURITY: unlike web (XSS), the threat here is at-rest device access; the
// Keychain/Keystore backing is the mitigation. In memory the key is plain bytes
// available to any code in the JS runtime — same trust model as expo-crypto.

import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

// The FILE, not the package barrel: this module is reachable from the iOS share
// extension (share-store hydrates the session mirror there), and expo-crypto's
// index re-exports the AES + Argon2 modules, which pull react-native-quick-crypto
// — ~390KB of JS plus readable-stream, buffer and nitro-modules — into the init
// of a process re-created on every share (docs/share-sheet.md). All this file
// wants is the three-function native wrapper, which costs nothing.
import {
  deleteSharedKeychainItem,
  getSharedKeychainItem,
  setSharedKeychainItem,
} from '@stxapps/expo-crypto/lib/shared-keychain';
import { bytesToHex, hexToBytes } from '@stxapps/shared';

import { APP_GROUP_ID } from './app-group';

export interface SessionRecord {
  // Public handle, kept for display/UX — not a secret.
  username: string;
  // Bearer token the API authenticates each request with.
  token: string;
  // Epoch ms when the token expires; lets the client pre-empt a stale request.
  expiresAt: number;
  // Raw AES-256-GCM key bytes — native's stand-in for web's non-extractable
  // CryptoKey (no such handle exists here; see expo-crypto's Account).
  encryptionKey: Uint8Array;
}

// The serialized shape that lands in secure-store (string values only). The key
// crosses as hex — the workspace convention for key material over a
// serialization boundary; shared's base64 pair needs `btoa`, which Hermes lacks.
interface PersistedSession {
  username: string;
  token: string;
  expiresAt: number;
  encryptionKeyHex: string;
}

// One active session at a time, under a fixed key. Identifies the record in
// BOTH stores — the secure-store entry and, on iOS, the shared-Keychain
// mirror's account (kSecAttrAccount) — so it's named for the thing it
// identifies, not for either backend. The two must agree; keeping one constant
// is what makes that structural.
const SESSION_KEY = 'bracemark-session';

// iOS ALSO mirrors the serialized session into the shared Keychain access group
// (the App Group id — expo-crypto's shared-keychain wrappers, no-ops off iOS):
// the share extension is a separate process that can't read the app's own
// Keychain entries, and the best-effort upload (docs/share-sheet.md)
// needs the token + encryptionKey there. The mirror is a COPY, never the source
// of truth: the app always reads its own entry (loadSession); only the
// extension reads the mirror (loadSharedSession). Every writer below keeps the
// two in step — and every mirror write/delete is best-effort (a Keychain
// hiccup must not fail sign-in/out; a stale-mirror upload just 401s and the
// outbox drain covers the share).
function mirrorSharedSession(serialized: string | null): Promise<void> {
  const op =
    serialized === null
      ? deleteSharedKeychainItem(APP_GROUP_ID, SESSION_KEY)
      : setSharedKeychainItem(APP_GROUP_ID, SESSION_KEY, serialized);
  return op.catch(() => undefined);
}

// AFTER_FIRST_UNLOCK instead of the WHEN_UNLOCKED default: background sync must
// read the key while the device is locked (any time after the first unlock
// since boot). iOS Keychain semantics — Android ignores the option (its
// Keystore entries are readable whenever the app runs).
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

// iOS Keychain entries survive app uninstall, so delete-and-reinstall would
// resurrect the old session (stale token, live key) — a signed-in ghost on what
// the user expects to be a clean app. This sentinel file lives in the app
// sandbox (which does die with the app): missing sentinel on load = fresh
// install, wipe any Keychain leftovers. Android uninstall clears secure-store
// too, so the sentinel is only ever load-bearing on iOS.
//
// This is INSTALL-lifecycle state, not session or account state: it must outlive
// every sign-out and data-delete for the life of the install. So it sits OUTSIDE
// the per-account teardown set — neither clearData (clear-data.ts) nor
// deleteAllData (delete-all-data.ts) nor clearSession touches it. Its only
// mutators are markInstalled() and the fresh-install branch of loadSession();
// deleting it elsewhere would re-arm the Keychain wipe on a device that was
// never reinstalled.
const INSTALL_SENTINEL = 'bracemark-install-sentinel';

function installSentinel(): File {
  return new File(Paths.document, INSTALL_SENTINEL);
}

// Both sentinel helpers fail toward "already installed": a broken filesystem
// read must not wipe a valid session on every launch — the reinstall ghost is
// the lesser evil.
function isFreshInstall(): boolean {
  try {
    return !installSentinel().exists;
  } catch {
    return false;
  }
}

function markInstalled(): void {
  try {
    // overwrite makes repeated calls idempotent (the marker carries no content).
    installSentinel().create({ intermediates: true, overwrite: true });
  } catch {
    // Swallowed deliberately — see fail-open note above.
  }
}

// In-memory mirror of the persisted session so synchronous consumers — chiefly
// the api client's auth header — can read the token without an async
// secure-store hit per request. The auth provider hydrates it once via
// loadSession() on launch; saveSession / clearSession keep it in step.
let current: SessionRecord | null = null;

// The live session record (in-memory), or null. Exposes the raw encryptionKey
// for the data layer; NOT expiry-gated (the key still decrypts local data
// offline even after the bearer token has lapsed).
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

function serialize(record: SessionRecord): string {
  const persisted: PersistedSession = {
    username: record.username,
    token: record.token,
    expiresAt: record.expiresAt,
    encryptionKeyHex: bytesToHex(record.encryptionKey),
  };
  return JSON.stringify(persisted);
}

// Null on any malformed payload (bad JSON, missing/mistyped fields) — a corrupt
// entry reads as signed-out rather than throwing into the auth provider.
function parse(raw: string): SessionRecord | null {
  let persisted: Partial<PersistedSession>;
  try {
    persisted = JSON.parse(raw) as Partial<PersistedSession>;
  } catch {
    return null;
  }
  if (
    typeof persisted.username !== 'string' ||
    typeof persisted.token !== 'string' ||
    typeof persisted.expiresAt !== 'number' ||
    typeof persisted.encryptionKeyHex !== 'string'
  ) {
    return null;
  }
  return {
    username: persisted.username,
    token: persisted.token,
    expiresAt: persisted.expiresAt,
    encryptionKey: hexToBytes(persisted.encryptionKeyHex),
  };
}

// Persist (or replace) the current session. Updates the in-memory mirror first
// so synchronous readers see it immediately. Sentinel before the write: if a
// save ever lands before the first loadSession() of a fresh install, the next
// launch's fresh-install wipe must not eat this session.
export async function saveSession(record: SessionRecord): Promise<void> {
  current = record;
  markInstalled();
  const serialized = serialize(record);
  await SecureStore.setItemAsync(SESSION_KEY, serialized, SECURE_OPTIONS);
  await mirrorSharedSession(serialized);
}

// Read the persisted session into the in-memory mirror and return it. Called
// once by the auth provider on launch to hydrate; thereafter getSession/getToken
// read the mirror synchronously. On a fresh install this instead wipes any
// Keychain leftover from a previous install (see INSTALL_SENTINEL) and reads as
// signed-out.
export async function loadSession(): Promise<SessionRecord | null> {
  if (isFreshInstall()) {
    await SecureStore.deleteItemAsync(SESSION_KEY, SECURE_OPTIONS);
    await mirrorSharedSession(null); // the mirror is a Keychain ghost too
    markInstalled();
    current = null;
    return null;
  }
  const raw = await SecureStore.getItemAsync(SESSION_KEY, SECURE_OPTIONS);
  const record = raw === null ? null : parse(raw);
  if (raw !== null && record === null) {
    // Corrupt entry: drop it now so it can't shadow a future session.
    await SecureStore.deleteItemAsync(SESSION_KEY, SECURE_OPTIONS);
    // The mirror is a copy of the same bad write — and if the two ever diverged
    // it could still hold a valid OLDER session, leaving the extension signed in
    // against an app that reads signed-out. The app owns the lifecycle; drop it.
    await mirrorSharedSession(null);
  }
  current = record;
  return current;
}

export async function clearSession(): Promise<void> {
  current = null;
  await SecureStore.deleteItemAsync(SESSION_KEY, SECURE_OPTIONS);
  await mirrorSharedSession(null);
}

// The iOS share extension's loadSession: read the shared-Keychain MIRROR (the
// only session the extension process can see) and hydrate the in-memory mirror
// so the api client's synchronous getToken()/getSession() work — the extension
// runs no AuthProvider, so nothing else hydrates it. Null when signed out, when
// the mirror write failed, or off iOS. Unlike loadSession this never deletes
// anything: the MAIN APP owns the entry's lifecycle; a corrupt/stale mirror
// just means no fast-path upload this share (the outbox drain still delivers).
export async function loadSharedSession(): Promise<SessionRecord | null> {
  const raw = await getSharedKeychainItem(APP_GROUP_ID, SESSION_KEY).catch(() => null);
  const record = raw === null ? null : parse(raw);
  if (record) current = record;
  return record;
}
