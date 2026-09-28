// How long bracemark-api keeps a session's row after the session ends — expired
// or revoked — before cleanup deletes it (docs/sessions.md, _revocation, expiry
// and unknown tokens_). It is the window in which a device that comes back can
// still be told `session_revoked`, and so erase its copy.
//
// It is also a public promise. /privacy (_How long we keep it_) and
// /delete-account (_What is deleted_, _What is kept_) state it in words, and
// they read `label` rather than typing it, so the pages and the cleanup that
// enforces the number can't drift. The api's cleanup is not built yet; when it
// lands it reads `days` from here (docs/sessions.md, `SESSION_PURGE_MS`).
//
// It is `platform:agnostic`, so it must stay portable to all three engines
// (browsers, workerd, Hermes): no runtime, no imports. See docs/architecture.md.
export const SESSION_RETENTION = {
  days: 365,
  /** As the public pages say it, mid-sentence: "…for a year…". */
  label: 'a year',
} as const;
