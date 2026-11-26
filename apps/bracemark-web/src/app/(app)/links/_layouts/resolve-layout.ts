// Which layout the links page renders for the stored `linksLayout` — the one place
// the table's fallbacks live (docs/link-layouts.md, _the table_). A stored value
// is never rewritten by any of this, so a choice made elsewhere still applies where
// it can.
//
//   - An unknown layout (synced from a client that has one we don't) renders as the
//     dense default, the same thing a user with no choice made sees.
//   - `table` renders the list when the account isn't entitled (a downgrade, or a
//     table chosen under another plan — upgrading brings it straight back), or when
//     the pane is narrower than TABLE_MIN_PANE_WIDTH, which also covers the browser
//     extension's popup and a phone: a table that can't show its own default
//     columns is a list with a header. Before the pane is measured (0) the table is
//     assumed to fit, so a wide window doesn't flash the list first; a narrow one
//     swaps on the first measurement. The minimum is written at a 16px root, like
//     the columns it is summed from, so `rootScale` (the root font size ÷ 16)
//     raises it with them: at a 24px default font the defaults need 1.5× the room.

import { TABLE_MIN_PANE_WIDTH } from '@stxapps/shared';

export type RenderedLayout = 'list' | 'card' | 'table';

export function resolveLayout(
  linksLayout: string,
  tableEntitled: boolean,
  paneWidth: number,
  rootScale = 1,
): RenderedLayout {
  if (linksLayout === 'card') return 'card';
  if (linksLayout === 'table') {
    const fits = paneWidth === 0 || paneWidth >= TABLE_MIN_PANE_WIDTH * rootScale;
    return tableEntitled && fits ? 'table' : 'list';
  }
  return 'list';
}
