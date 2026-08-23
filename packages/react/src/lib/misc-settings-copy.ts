import type { LinksLayout, LinkSortOn, LinkSortOrder, ThemeMode } from '@stxapps/shared';

// The label and hint on every radio row in Settings → Misc. — link layout, link
// sort, and theme. Rendered on TWO surfaces, `_misc/misc-section.tsx` and its
// native port, which are separate components that had every one of these strings
// written out twice.
//
// Only the WORDS are here. The ICON is not: web hands its option records a
// rendered `<Sun className="size-4" />` and native hands them the `LucideIcon`
// component itself, so the icon is genuinely a different value on each platform
// and stays at the call site. Each section keeps its own record and spreads these
// into it.
//
// Keyed by the same union the setting is stored as, so a new member of
// `THEME_MODES` (or the others) fails to typecheck here until it has words —
// which is the point of the `Record` rather than a loose object.

type OptionCopy = { label: string; hint: string };

export const LAYOUT_OPTION_COPY: Record<LinksLayout, OptionCopy> = {
  list: { label: 'List', hint: 'A dense, single-column list.' },
  card: { label: 'Card', hint: 'A grid of preview cards.' },
};

export const SORT_ON_OPTION_COPY: Record<LinkSortOn, OptionCopy> = {
  updatedAt: { label: 'Date modified', hint: 'Order by when a link was last changed.' },
  createdAt: { label: 'Date added', hint: 'Order by when a link was saved.' },
};

export const SORT_ORDER_OPTION_COPY: Record<LinkSortOrder, OptionCopy> = {
  desc: { label: 'Newest first', hint: 'The most recent links at the top.' },
  asc: { label: 'Oldest first', hint: 'The oldest links at the top.' },
};

export const THEME_MODE_OPTION_COPY: Record<ThemeMode, OptionCopy> = {
  light: { label: 'Light', hint: 'Always use the light theme.' },
  dark: { label: 'Dark', hint: 'Always use the dark theme.' },
  system: { label: 'System', hint: 'Follow your device’s appearance.' },
  custom: { label: 'Custom time', hint: 'Light by day, dark by night — you set the times.' },
};
