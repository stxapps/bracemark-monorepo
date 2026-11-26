import type {
  AddressMode,
  CardImageHeight,
  CardSize,
  DateMode,
  LinkFieldId,
  LinksLayout,
  LinkSortOn,
  LinkSortOrder,
  TableColumnId,
  ThemeMode,
} from '@stxapps/shared';

// The label and hint on every radio row in Settings → Appearance — theme, link
// layout and its display options, and link sort. Rendered on TWO surfaces each
// (web's `_appearance/` section and its native port, plus the View options
// popover/sheet), which are separate components that had every one of these strings
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
  table: { label: 'Table', hint: 'Rows with the columns you choose, on a wide screen.' },
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

// The display options (docs/link-layouts.md). Short labels: these sit in compact
// rows under the layout radios, not in hinted option cards.
export const TITLE_LINES_COPY = { label: 'Title lines', hint: 'The most lines a title can use.' };
export const TAG_LINES_COPY = {
  label: 'Tag lines',
  hint: 'The most lines tags can use. The rest go behind “+N”.',
};
export const CARD_SIZE_COPY = { label: 'Card size' };
export const CARD_IMAGE_COPY = { label: 'Image' };

export const CARD_SIZE_OPTION_COPY: Record<CardSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

// The card's image: off, or one of the heights.
export const CARD_IMAGE_OPTION_COPY: Record<CardImageHeight | 'off', string> = {
  off: 'Off',
  short: 'Short',
  medium: 'Medium',
  tall: 'Tall',
};

export const LINK_FIELD_COPY: Record<LinkFieldId, string> = {
  image: 'Thumbnail',
  address: 'Address',
  listName: 'List name',
  tags: 'Tags',
  date: 'Date',
  note: 'Note icon',
  keptCopy: 'Kept-copy icon',
};

export const ADDRESS_MODE_COPY: Record<AddressMode, string> = {
  host: 'Site',
  url: 'Full URL',
  none: 'None',
};

export const DATE_MODE_COPY: Record<DateMode, string> = {
  sorted: 'Sort date',
  createdAt: 'Date added',
  updatedAt: 'Date modified',
  none: 'None',
};

// The table's column headers, and the column chooser's rows (web only — the table
// is). The title column has no entry: it is always there.
export const TABLE_COLUMN_COPY: Record<TableColumnId, string> = {
  host: 'Site',
  url: 'URL',
  listName: 'List',
  tags: 'Tags',
  createdAt: 'Added',
  updatedAt: 'Modified',
  note: 'Note',
  keptCopy: 'Copy',
};
