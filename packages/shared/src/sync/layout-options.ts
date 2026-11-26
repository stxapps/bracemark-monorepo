// The links layouts' display options — the BEHAVIOR half of `settings/layout.enc`
// (its SHAPE is `settingsLayoutSchema` in entities.ts; the same shape/behavior split
// as entities.ts vs. extraction.ts). Writer enumerations, defaults, the read-edge
// coercion, the field registry, the write-side merge, and how the "pack" — the
// layout choice, its options and the sort — resolves from its sources. One home so
// web-react and expo-react can't drift on any of it. The design and its reasons:
// docs/link-layouts.md.

import {
  layoutOptionsSchema,
  type LinkSortOn,
  type LinkSortOrder,
  type SettingsGeneral,
  type SettingsLayout,
  type StoredLayoutOptions,
} from './entities';

// --- the writer enumerations ------------------------------------------------

// How many lines a title may use. A CAP, not a reservation: a short title looks
// the same at every value, and spacing, size and weight never change with it.
export const TITLE_LINE_COUNTS = [1, 2, 3] as const;
export type TitleLines = (typeof TITLE_LINE_COUNTS)[number];

// How many lines the tag strip may use before the rest go behind "+N". A cap too:
// one or two short tags take one line at every value.
export const TAG_LINE_COUNTS = [1, 2, 3] as const;
export type TagLines = (typeof TAG_LINE_COUNTS)[number];

// A card SIZE, not a column count: each device turns it into its own column count
// from its own width (the per-size width bounds live with each app's card layout).
export const CARD_SIZES = ['small', 'medium', 'large'] as const;
export type CardSize = (typeof CARD_SIZES)[number];

// What each card size MEANS, in px/pt: the narrowest a card may get before the
// grid drops a column (`min`), and the widest a card is drawn even when its cell is
// wider (`max` — the cell's leftover becomes margin either side, so a lone card
// never stretches into a banner with a title stranded on one long line). Both apps'
// column counts come from these, so a size gives the same columns at the same
// width on web and on a phone.
//
//   - small — two columns on a phone held upright (a 390pt phone fits two of 160 +
//     16), the size's whole point on a narrow screen. The host truncates sooner in
//     a card that narrow; the user who picks small has chosen more cards over a
//     longer host.
//   - medium — the 300 / 420 every card had before the option existed: one column
//     on every upright phone, three or four on a desktop.
//   - large — one column on a phone, big cards on a desktop.
export const CARD_SIZE_WIDTHS: Record<CardSize, { min: number; max: number }> = {
  small: { min: 160, max: 240 },
  medium: { min: 300, max: 420 },
  large: { min: 400, max: 600 },
};

// How tall the card's banner is, as a fraction of the card's width. The card keeps
// its width; only the banner (and so the card) gets shorter. `CARD_IMAGE_ASPECTS`
// below is the number each one means.
export const CARD_IMAGE_HEIGHTS = ['short', 'medium', 'tall'] as const;
export type CardImageHeight = (typeof CARD_IMAGE_HEIGHTS)[number];

// Banner height ÷ card width. `tall` is the 12:7 every card had before the option
// existed; most saved preview images are about 1.91:1, so 2:1 crops almost nothing
// and 3:1 crops the top and bottom. Fixed per value, so a late image load still
// can't reflow a measured row (docs/client-queries.md).
export const CARD_IMAGE_ASPECTS: Record<CardImageHeight, number> = {
  short: 1 / 3,
  medium: 1 / 2,
  tall: 7 / 12,
};

// What the address line shows: the host, the full URL, or nothing. ONE value, not
// two toggles — the host and the URL are the same line (the favicon, then one of
// them, cut off at one line), and two toggles would allow "both", which a card or a
// list row has no room for. The table shows both, as separate columns.
export const ADDRESS_MODES = ['host', 'url', 'none'] as const;
export type AddressMode = (typeof ADDRESS_MODES)[number];

// Which date a card or list row shows. ONE value: a row has room for one date, and
// its dates read in order down the list only when the date shown is the one the
// list is sorted by — `sorted`, the list's behavior before the option existed.
export const DATE_MODES = ['sorted', 'createdAt', 'updatedAt', 'none'] as const;
export type DateMode = (typeof DATE_MODES)[number];

// The layouts that take the card/list display options. `table` has its own
// (columns), shaped separately below.
export type OptionLayout = 'card' | 'list';

// --- the table ---------------------------------------------------------------

// The table's columns (docs/link-layouts.md, _the table_). The title is not one of
// them: it is always the first column and the one that flexes, so it can't be
// hidden or moved. Each other column has a FIXED width — the table is the one
// budgeted surface (one truncated line per cell), so its widths are a plan, not a
// measurement — and a PRIORITY: when the chosen columns don't fit the pane beside
// the title's minimum, the lowest-priority ones drop first (behind "+N hidden"),
// never a sideways scroll. A date column also names the sort field its header
// sorts by.
export const TABLE_COLUMN_IDS = [
  'host',
  'url',
  'listName',
  'tags',
  'createdAt',
  'updatedAt',
  'note',
  'keptCopy',
] as const;
export type TableColumnId = (typeof TABLE_COLUMN_IDS)[number];

export interface TableColumnDef {
  width: number;
  priority: number;
  sortOn?: LinkSortOn;
}

export const TABLE_COLUMNS: Record<TableColumnId, TableColumnDef> = {
  host: { width: 180, priority: 90 },
  updatedAt: { width: 112, priority: 85, sortOn: 'updatedAt' },
  createdAt: { width: 112, priority: 80, sortOn: 'createdAt' },
  tags: { width: 220, priority: 70 },
  listName: { width: 160, priority: 60 },
  url: { width: 260, priority: 40 },
  note: { width: 56, priority: 30 },
  keptCopy: { width: 56, priority: 20 },
};

// What a table shows before the user picks: the address, the tags, and the date
// the default sort orders by.
export const DEFAULT_TABLE_COLUMNS: readonly TableColumnId[] = ['host', 'tags', 'updatedAt'];

// The narrowest the title column may get before a column drops, and the narrowest
// PANE that shows a table at all — below it the list layout renders instead. Sized
// for the title and three default columns (180 + 220 + 112) with the row's own
// chrome: a table that can't show its own defaults is a list with a header.
export const TABLE_TITLE_MIN_WIDTH = 280;
export const TABLE_MIN_PANE_WIDTH = 840;

export interface TableOptions {
  // The chosen columns, in order — known ids only (unknown ones a newer client
  // wrote are kept by the writer, mergeLayoutOptions, and skipped here).
  columns: TableColumnId[];
}

export function coerceTableOptions(stored: { columns?: unknown[] } | undefined): TableOptions {
  if (!stored?.columns) return { columns: [...DEFAULT_TABLE_COLUMNS] };
  const seen = new Set<TableColumnId>();
  for (const entry of stored.columns) {
    const id = (entry as { id?: unknown } | null)?.id;
    if ((TABLE_COLUMN_IDS as readonly unknown[]).includes(id)) seen.add(id as TableColumnId);
  }
  return { columns: [...seen] };
}

// Which chosen columns fit `available` px beside the title's minimum: drop the
// lowest-priority columns until the rest fit, keeping the chosen ORDER for those
// that stay. What drops is shown as "+N hidden", never scrolled to sideways.
export function fitTableColumns(
  columns: readonly TableColumnId[],
  available: number,
): { shown: TableColumnId[]; hidden: TableColumnId[] } {
  const budget = available - TABLE_TITLE_MIN_WIDTH;
  const kept = new Set(columns);
  let used = columns.reduce((sum, id) => sum + TABLE_COLUMNS[id].width, 0);
  const byPriority = [...columns].sort(
    (a, b) => TABLE_COLUMNS[a].priority - TABLE_COLUMNS[b].priority,
  );
  for (const id of byPriority) {
    if (used <= budget) break;
    kept.delete(id);
    used -= TABLE_COLUMNS[id].width;
  }
  return {
    shown: columns.filter((id) => kept.has(id)),
    hidden: columns.filter((id) => !kept.has(id)),
  };
}

// --- the resolved shapes ------------------------------------------------------

export interface LinkFields {
  image: boolean;
  address: AddressMode;
  listName: boolean;
  tags: boolean;
  date: DateMode;
  note: boolean;
  keptCopy: boolean;
}

export interface CardOptions {
  titleLines: TitleLines;
  tagLines: TagLines;
  size: CardSize;
  imageHeight: CardImageHeight;
  fields: LinkFields;
}

export interface ListOptions {
  titleLines: TitleLines;
  tagLines: TagLines;
  fields: LinkFields;
}

export interface LayoutOptions {
  card: CardOptions;
  list: ListOptions;
  table: TableOptions;
}

// --- the defaults -------------------------------------------------------------

// THE DEFAULTS REPRODUCE THE LOOK FROM BEFORE THE OPTIONS EXISTED, exactly. A user
// who never opens them sees no change — which makes it a test: an absent file
// renders as the app always did. Cards showed no date; list rows showed the sorted
// field's date; neither showed a list name or a kept-copy icon.
export const DEFAULT_CARD_OPTIONS: CardOptions = {
  titleLines: 2,
  tagLines: 1,
  size: 'medium',
  imageHeight: 'tall',
  fields: {
    image: true,
    address: 'host',
    listName: false,
    tags: true,
    date: 'none',
    note: true,
    keptCopy: false,
  },
};

export const DEFAULT_LIST_OPTIONS: ListOptions = {
  titleLines: 2,
  tagLines: 1,
  fields: {
    image: true,
    address: 'host',
    listName: false,
    tags: true,
    date: 'sorted',
    note: true,
    keptCopy: false,
  },
};

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = {
  card: DEFAULT_CARD_OPTIONS,
  list: DEFAULT_LIST_OPTIONS,
  table: { columns: [...DEFAULT_TABLE_COLUMNS] },
};

// --- the read edge ------------------------------------------------------------

function oneOf<T extends string | number>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

export function coerceTitleLines(value: unknown, fallback: TitleLines = 2): TitleLines {
  return oneOf(TITLE_LINE_COUNTS, value, fallback);
}

export function coerceTagLines(value: unknown, fallback: TagLines = 1): TagLines {
  return oneOf(TAG_LINE_COUNTS, value, fallback);
}

export function coerceCardSize(value: unknown): CardSize {
  return oneOf(CARD_SIZES, value, 'medium');
}

export function coerceCardImageHeight(value: unknown): CardImageHeight {
  return oneOf(CARD_IMAGE_HEIGHTS, value, 'tall');
}

// Narrow a stored fields object to one the UI can render, field by field, each
// falling back to the layout's own default. Unknown field ids are skipped here
// (and kept by the writer — mergeLayoutOptions).
export function coerceFields(value: unknown, defaults: LinkFields): LinkFields {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const bool = (key: keyof LinkFields, fallback: boolean) =>
    typeof raw[key] === 'boolean' ? (raw[key] as boolean) : fallback;
  return {
    image: bool('image', defaults.image),
    address: oneOf(ADDRESS_MODES, raw.address, defaults.address),
    listName: bool('listName', defaults.listName),
    tags: bool('tags', defaults.tags),
    date: oneOf(DATE_MODES, raw.date, defaults.date),
    note: bool('note', defaults.note),
    keptCopy: bool('keptCopy', defaults.keptCopy),
  };
}

export function coerceLayoutOptions(stored: StoredLayoutOptions | undefined): LayoutOptions {
  const card = stored?.card;
  const list = stored?.list;
  return {
    card: {
      titleLines: coerceTitleLines(card?.titleLines, DEFAULT_CARD_OPTIONS.titleLines),
      tagLines: coerceTagLines(card?.tagLines, DEFAULT_CARD_OPTIONS.tagLines),
      size: coerceCardSize(card?.size),
      imageHeight: coerceCardImageHeight(card?.imageHeight),
      fields: coerceFields(card?.fields, DEFAULT_CARD_OPTIONS.fields),
    },
    list: {
      titleLines: coerceTitleLines(list?.titleLines, DEFAULT_LIST_OPTIONS.titleLines),
      tagLines: coerceTagLines(list?.tagLines, DEFAULT_LIST_OPTIONS.tagLines),
      fields: coerceFields(list?.fields, DEFAULT_LIST_OPTIONS.fields),
    },
    table: coerceTableOptions(stored?.table),
  };
}

// Just the per-layout options of a stored `layout.enc` (or device row) — the part
// mergeLayoutOptions patches. Pack fields and the clock are left out.
export function storedOptionsOf(
  file: SettingsLayout | StoredLayoutOptions | undefined,
): StoredLayoutOptions {
  if (!file) return {};
  const { card, list, table } = file;
  return {
    ...(card !== undefined ? { card } : {}),
    ...(list !== undefined ? { list } : {}),
    ...(table !== undefined ? { table } : {}),
  };
}

// --- the field registry -------------------------------------------------------

export type LinkFieldId = keyof LinkFields;

// One entry per piece of information a card or list row can show or hide. The
// title always shows (a link with no title shows its URL as the title), and so
// does the pin icon: pinned links sit at the top whatever the sort, and without the
// icon an old link at the top reads as a bug. The note icon is a toggle because it
// is the only place a note's text shows (on hover) — information, not just state.
// The table's columns are a registry of their own (phase 5 of the plan).
export interface LinkFieldDef {
  id: LinkFieldId;
  // `toggle` → a boolean; `choice` → one of a fixed set (ADDRESS_MODES, DATE_MODES).
  kind: 'toggle' | 'choice';
  layouts: readonly OptionLayout[];
}

// The words for each are UI copy and live with the rest of it
// (@stxapps/react, `LINK_FIELD_COPY`).
export const LINK_FIELDS: readonly LinkFieldDef[] = [
  { id: 'image', kind: 'toggle', layouts: ['card', 'list'] },
  { id: 'address', kind: 'choice', layouts: ['card', 'list'] },
  { id: 'listName', kind: 'toggle', layouts: ['card', 'list'] },
  { id: 'tags', kind: 'toggle', layouts: ['card', 'list'] },
  { id: 'date', kind: 'choice', layouts: ['card', 'list'] },
  { id: 'note', kind: 'toggle', layouts: ['card', 'list'] },
  { id: 'keptCopy', kind: 'toggle', layouts: ['card', 'list'] },
];

// --- the write edge -----------------------------------------------------------

// A writer's patch: strict values, any subset. `fields` patches field by field.
export interface CardOptionsPatch extends Partial<Omit<CardOptions, 'fields'>> {
  fields?: Partial<LinkFields>;
}
export interface ListOptionsPatch extends Partial<Omit<ListOptions, 'fields'>> {
  fields?: Partial<LinkFields>;
}
export interface LayoutOptionsPatch {
  card?: CardOptionsPatch;
  list?: ListOptionsPatch;
  // The table's chosen columns, whole and in order.
  table?: { columns: TableColumnId[] };
}

type Loose = Record<string, unknown>;

// Apply a patch on top of the STORED options, keeping everything the patch doesn't
// name — an option, a field id or a layout a newer client wrote included. That is
// the write half of "unknown ids are skipped when rendering and kept when writing":
// an older client must never delete what it can't see.
export function mergeLayoutOptions(
  stored: StoredLayoutOptions,
  patch: LayoutOptionsPatch,
): StoredLayoutOptions {
  const next: Loose = { ...stored };
  for (const layout of ['card', 'list'] as const) {
    const layoutPatch = patch[layout];
    if (!layoutPatch) continue;
    const current = (stored[layout] ?? {}) as Loose;
    const { fields, ...rest } = layoutPatch;
    next[layout] = {
      ...current,
      ...rest,
      ...(fields ? { fields: { ...((current.fields ?? {}) as Loose), ...fields } } : {}),
    };
  }
  if (patch.table) {
    // A chosen column keeps its stored entry (a width a newer client set, say);
    // an entry this build doesn't know stays, after the known ones — an older
    // client must not delete a column it can't render.
    const current = (stored.table ?? {}) as Loose;
    const entries = Array.isArray(current.columns) ? (current.columns as unknown[]) : [];
    const entryOf = (id: string) =>
      entries.find((e) => (e as { id?: unknown } | null)?.id === id) ?? { id };
    const unknown = entries.filter(
      (e) => !(TABLE_COLUMN_IDS as readonly unknown[]).includes((e as { id?: unknown } | null)?.id),
    );
    next.table = { ...current, columns: [...patch.table.columns.map(entryOf), ...unknown] };
  }
  return next as StoredLayoutOptions;
}

// --- resolving the pack -------------------------------------------------------

// What one source says about the pack, raw. The layout and the sort stay `string`:
// a newer client's value must reach the UI intact and round-trip (entities.ts,
// LINKS_LAYOUTS). The options are coerced — nothing renders from them raw.
export interface LayoutPackSide {
  linksLayout: string;
  sortOn: string;
  sortOrder: string;
  options: LayoutOptions;
  // The uncoerced options, for a writer that starts from them (the device side
  // seeds itself from the synced side on its first options write).
  storedOptions: StoredLayoutOptions;
}

const DEFAULT_LINKS_LAYOUT = 'list';
const DEFAULT_SORT_ON: LinkSortOn = 'updatedAt';
const DEFAULT_SORT_ORDER: LinkSortOrder = 'desc';

// The SYNCED side. Each pack field reads `layout.enc` first and falls back to the
// copy in `general.enc`, which is where these three lived before the move and where
// an older client still writes them (and where an old backup carries them). Per
// field, so a `layout.enc` written only for an option doesn't hide the layout.
export function syncLayoutPack(
  layout: SettingsLayout | undefined,
  general: SettingsGeneral | undefined,
): LayoutPackSide {
  const storedOptions = storedOptionsOf(layout);
  return {
    linksLayout: layout?.linksLayout ?? general?.linksLayout ?? DEFAULT_LINKS_LAYOUT,
    sortOn: layout?.sortOn ?? general?.sortOn ?? DEFAULT_SORT_ON,
    sortOrder: layout?.sortOrder ?? general?.sortOrder ?? DEFAULT_SORT_ORDER,
    options: coerceLayoutOptions(storedOptions),
    storedOptions,
  };
}

// The device-local row's pack fields, as both apps' stores keep them. Untrusted:
// an older or newer build may have written the row.
export interface LocalLayoutPackFields {
  linksLayout?: string;
  sortOn?: string;
  sortOrder?: string;
  layoutOptions?: unknown;
}

// The DEVICE side. The layout keeps its old rule (absent → `list`). The sort and
// the options came to the Device source later, so a device row written before them
// has neither: each falls back to the SYNCED value, which is what that device was
// showing — so nothing changes for a user already on Device, and the first device
// write of an option seeds from the synced options (see mergeLayoutOptions'
// callers) rather than resetting the rest to defaults.
export function localLayoutPack(
  local: LocalLayoutPackFields | undefined,
  sync: LayoutPackSide,
): LayoutPackSide {
  const parsed =
    local?.layoutOptions === undefined
      ? undefined
      : layoutOptionsSchema.safeParse(local.layoutOptions).data;
  const storedOptions = parsed ?? sync.storedOptions;
  return {
    linksLayout: local?.linksLayout ?? DEFAULT_LINKS_LAYOUT,
    sortOn: local?.sortOn ?? sync.sortOn,
    sortOrder: local?.sortOrder ?? sync.sortOrder,
    options: parsed ? coerceLayoutOptions(parsed) : sync.options,
    storedOptions,
  };
}
