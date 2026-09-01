import { PLAN_LABELS } from '@stxapps/shared';

// The "somewhere else to go" cards, for the two pages a visitor can dead-end on:
// the 404 and /support. Each picks its own three and orders them for its own
// reader — what they SHARED was the /pricing card, written out word for word in
// two files that never see each other (docs/brand-assets.md, _the copy that
// exists twice lives in one file_). Nothing but this module keeps a change to the
// trial or the plan split from landing on one page and not the other.
//
// Only the card that is genuinely shared moves here. Both pages also point at
// /faq, and deliberately not in the same words: on /support it is an instruction
// to someone about to write in ("Read the FAQ first"), on the 404 it is a
// signpost for someone who is merely lost. Folding those two into one entry is
// how this file would become the reason a page says the wrong thing — the same
// rule the shared-copy modules follow, that only the words with a real twin move.
//
// Strings, so `.ts`: `faq.tsx` is a `.tsx` in this folder because its answers are
// `ReactNode` and link out. Nothing here does.
export type ElsewhereCard = { href: string; title: string; body: string };

export const PRICING_CARD: ElsewhereCard = {
  href: '/pricing',
  title: 'Plans and what they include',
  body: `What the free plan covers, what ${PLAN_LABELS.plus} adds, and how the trial works.`,
};
