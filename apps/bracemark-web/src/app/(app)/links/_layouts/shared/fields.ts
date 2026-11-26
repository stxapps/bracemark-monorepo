// What a link row or card shows, per the layout's display options
// (docs/link-layouts.md, _the field registry_) — the small rules both web layouts
// apply the same way, so they can't drift: the title clamp, which date, which
// address, whether the list name says anything.

import {
  type AddressMode,
  type DateMode,
  displayUrl,
  hostFromText,
  type LinkSortOn,
  type TitleLines,
} from '@stxapps/shared';
import { type LinkView } from '@stxapps/web-react';

import { type Selection } from '../../_contexts/page-provider';

// A FIXED map, not `line-clamp-${n}`: Tailwind builds its stylesheet from the class
// names it can see in the source, so a name assembled at runtime has no rule behind
// it and the title quietly stops clamping at all.
export const TITLE_CLAMP: Record<TitleLines, string> = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
};

// The date a row shows, or undefined for `none`. `sorted` is the field the list is
// ordered by, so its relative values read in order down the list; the verb names
// which instant it is (the visible text is bare, so "Added"/"Updated" rides the
// title and the accessible name).
export function rowDate(
  link: LinkView,
  mode: DateMode,
  sortOn: LinkSortOn,
): { epochMs: number; verb: string } | undefined {
  const field = mode === 'sorted' ? sortOn : mode === 'none' ? undefined : mode;
  if (!field) return undefined;
  return { epochMs: link[field], verb: field === 'createdAt' ? 'Added' : 'Updated' };
}

// The address line's text: the host, the full URL (without its scheme — the
// same `displayUrl` a title-less link shows as its title), or nothing.
export function addressText(link: LinkView, mode: AddressMode): string | undefined {
  if (mode === 'host') return hostFromText(link.url);
  if (mode === 'url') return displayUrl(link.url);
  return undefined;
}

// The link's list name, or undefined when it says nothing: off, a list this
// device doesn't know (deleted, not yet synced — skipped, like a tag), or the list
// being viewed, where every row would repeat the page's own title. Links in a
// LOCKED list are out of every view while it's locked, so no name leaks through.
export function listNameFor(
  link: LinkView,
  show: boolean,
  listNames: Map<string, string>,
  selection: Selection,
): string | undefined {
  if (!show) return undefined;
  if (selection.kind === 'list' && selection.id === link.listId) return undefined;
  return listNames.get(link.listId);
}
