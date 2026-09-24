// Read/write helpers over the device-local review-prompt row (ReviewPromptValue
// in db.ts). Shape only — WHEN to ask is bracemark-expo's `lib/review-prompt.ts`,
// which owns the rules. The one other writer is share-store, whose saves count
// toward the next ask but never raise one (`countReviewPromptSave`). Synchronous
// like sidebar-view-store (drizzle's expo driver is a sync driver) and
// best-effort in the same way: this runs on the tail of a successful save, and
// nothing about a review prompt is worth failing that save over. A failed read
// looks like a device that has never been asked and has saved nothing, which is
// the conservative answer — it re-earns the ask.

import { eq } from 'drizzle-orm';

import { getDb, reviewPrompt, type ReviewPromptValue } from './db';

// The constant primary key — one bag per device (db.ts).
const REVIEW_PROMPT_ID = 'singleton' as const;

const EMPTY: ReviewPromptValue = {
  savesSinceAsk: 0,
  lastAskedAt: null,
  askCount: 0,
  openedStorePage: false,
};

// The stored bookkeeping, or the empty state when none is stored or the row is
// unreadable. Defensive about the stored shape (untrusted JSON from another
// build): a field that isn't a finite non-negative number reads as its empty
// value rather than reaching the arithmetic as NaN, which would compare false
// against every threshold and silently never ask again. A row written before
// `askCount`/`openedStorePage` existed reads them as never-asked and not-opened.
export function readReviewPromptState(): ReviewPromptValue {
  try {
    const row = getDb()
      .select()
      .from(reviewPrompt)
      .where(eq(reviewPrompt.id, REVIEW_PROMPT_ID))
      .get();
    const value: Partial<Record<keyof ReviewPromptValue, unknown>> = row?.value ?? {};
    const count = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0;
    return {
      savesSinceAsk: count(value.savesSinceAsk) ? Math.floor(value.savesSinceAsk) : 0,
      lastAskedAt: count(value.lastAskedAt) ? value.lastAskedAt : null,
      askCount: count(value.askCount) ? Math.floor(value.askCount) : 0,
      openedStorePage: value.openedStorePage === true,
    };
  } catch {
    return EMPTY;
  }
}

// Persist the whole value. A no-op on storage failure.
export function writeReviewPromptState(value: ReviewPromptValue): void {
  try {
    getDb()
      .insert(reviewPrompt)
      .values({ id: REVIEW_PROMPT_ID, value })
      .onConflictDoUpdate({ target: reviewPrompt.id, set: { value } })
      .run();
  } catch {
    // Storage unavailable — this session just doesn't remember.
  }
}

// One more save toward the next ask, and nothing else — for a save that must
// never raise the sheet itself (the share sheet's, landed by share-store).
export function countReviewPromptSave(): void {
  const state = readReviewPromptState();
  writeReviewPromptState({ ...state, savesSinceAsk: state.savesSinceAsk + 1 });
}
