import { Linking, ScrollView, useWindowDimensions, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { ImageOff } from 'lucide-react-native';

import {
  isReaderHref,
  type ReaderBlock,
  type ReaderCell,
  type ReaderDoc,
  type ReaderRun,
} from '@stxapps/shared';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { MAX_FONT_SIZE_MULTIPLIER } from '../../lib/font-scale';
import { cn } from '../../lib/utils';

// A read-mode copy, rendered natively — the expo twin of web-ui's ReaderArticle
// (`components/reader/reader-article.tsx`, whose header has the full rules). The copy
// is blocks of plain strings (@stxapps/shared reader/reader-doc.ts), and every one of
// them reaches the screen as a `<Text>` child: there is no WebView here and nothing
// that interprets markup, which is the whole safety argument
// (docs/link-extraction-keep.md, the format tripwire).
//
//   - A link is a nested `<Text>` whose press opens the target in the system browser —
//     only when `isReaderHref` passes HERE, at render (a backup is an outside file).
//   - A figure's picture comes from the CALLER's `images` map — the copy's own image
//     pack, read off disk (expo-react useReaderImages) — by the key the block names.
//     The document holds no address and this file builds none; a figure with no kept
//     image is its words (`FigureBlock`, below).
//   - A table is rows of Views in a sideways scroller — React Native has no table —
//     with each column's width sized from its longest line (`TableBlock`, below).
//   - An unknown block kind renders nothing, and the rest of the copy still renders.
//   - Everything is `selectable` and scales with the OS text size through the app's
//     own Text (lib/font-scale.ts) — a reader that ignored Dynamic Type would be the
//     worst place in the app to do it (docs/accessibility.md).
//   - `writingDirection` follows the copy's `dir`, so an RTL article reads right.

const HEADING_CLASS: Record<number, string> = {
  1: 'text-xl font-semibold',
  2: 'text-lg font-semibold',
  3: 'text-base font-semibold',
};

function openHref(href: string): void {
  void Linking.openURL(href).catch(() => undefined);
}

function Runs({ runs }: { runs: ReaderRun[] }) {
  return (
    <>
      {runs.map((run, i) => {
        const href = isReaderHref(run.href) ? run.href : undefined;
        return (
          <Text
            key={i}
            className={cn(
              run.bold && 'font-semibold',
              run.italic && 'italic',
              run.code && 'bg-muted font-mono text-sm',
              href && 'text-foreground underline',
            )}
            onPress={href ? () => openHref(href) : undefined}
            accessibilityRole={href ? 'link' : undefined}
          >
            {run.text}
          </Text>
        );
      })}
    </>
  );
}

// A table's rows as the renderer reads them — web-ui's `tableRows`, for the same
// reason: the capture writes a rectangular grid, but a copy is stored bytes and a
// backup is an outside file, so a row that isn't `{ cells: [...] }` contributes none.
type TableCell = { runs: ReaderRun[]; header: boolean };

function tableRows(block: ReaderBlock): TableCell[][] {
  const rows: unknown = block.rows;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row: unknown): TableCell[] => {
      const cells = (row as { cells?: unknown } | null)?.cells;
      if (!Array.isArray(cells)) return [];
      // A cell with no readable runs is an EMPTY cell, not a missing one: dropping it
      // would shift every cell after it one column to the left.
      return cells.map((cell: ReaderCell | null | undefined) => ({
        runs: Array.isArray(cell?.runs) ? cell.runs : [],
        header: cell?.header === true,
      }));
    })
    .filter((cells) => cells.length > 0);
}

// Column widths, in dp at the default text size. There is no table layout to ask —
// each cell is a View with a fixed width — so a column is as wide as its LONGEST
// LINE wants, between a floor that keeps a short column tappable to select and a
// ceiling past which the text wraps instead. ~7.5dp a character is the app's 14pt
// face; it is an estimate, and wrapping absorbs the error.
const COLUMN_MIN = 72;
const COLUMN_MAX = 240;
const CHAR_WIDTH = 7.5;
const CELL_PADDING = 24;

function columnWidths(rows: TableCell[][]): number[] {
  // A reduce, not `Math.max(...rows.map())`: a spread of a hostile table's rows is an argument
  // list as long as the table, and past ~100k elements it throws.
  const columns = rows.reduce((most, cells) => Math.max(most, cells.length), 0);
  return Array.from({ length: columns }, (_, c) => {
    let longest = 0;
    for (const cells of rows) {
      const text = (cells[c]?.runs ?? []).map((run) => run.text).join('');
      for (const line of text.split('\n')) longest = Math.max(longest, line.length);
    }
    return Math.min(Math.max(longest * CHAR_WIDTH + CELL_PADDING, COLUMN_MIN), COLUMN_MAX);
  });
}

function TableBlock({ block, rtl }: { block: ReaderBlock; rtl: boolean }) {
  // The widths are dp and the text is not: it grows with the OS text size, up to the
  // app's cap (lib/font-scale.ts). Scale the columns by the same factor, or a large
  // text setting wraps every cell to a word a line.
  const { fontScale } = useWindowDimensions();
  const rows = tableRows(block);
  if (rows.length === 0) return null;
  const scale = Math.min(Math.max(fontScale, 1), MAX_FONT_SIZE_MULTIPLIER);
  const widths = columnWidths(rows).map((width) => Math.round(width * scale));
  const caption = block.runs ?? [];
  const textStyle = { writingDirection: rtl ? ('rtl' as const) : ('ltr' as const) };

  return (
    <View className="my-4">
      {caption.length > 0 ? (
        <Text selectable style={textStyle} className="mb-2 text-sm text-muted-foreground">
          <Runs runs={caption} />
        </Text>
      ) : null}
      <ScrollView horizontal testID="reader-table">
        <View className="rounded-lg border border-border">
          {rows.map((cells, r) => (
            <View
              key={r}
              className={cn('border-border', r > 0 && 'border-t')}
              // The document's direction, not the app's: an RTL article's first
              // column is on the right whatever language the phone is in.
              style={{ flexDirection: rtl ? 'row-reverse' : 'row' }}
            >
              {cells.map((cell, c) => (
                <View
                  key={c}
                  style={{ width: widths[c] }}
                  className={cn('px-3 py-2', cell.header && 'bg-muted/50')}
                >
                  <Text
                    selectable
                    style={textStyle}
                    className={cn('text-sm leading-5', cell.header && 'font-semibold')}
                  >
                    <Runs runs={cell.runs} />
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {block.truncated === true ? (
        <Text className="mt-2 text-sm text-muted-foreground">
          The rest of this table wasn’t kept.
        </Text>
      ) : null}
    </View>
  );
}

// One kept image by the key its figure names — expo-react's `ReaderImageView` fits.
export interface ReaderArticleImage {
  uri: string;
  width: number;
  height: number;
}

interface ImageContext {
  images: ReadonlyMap<string, ReaderArticleImage>;
  // False while the pack may still arrive: a figure then holds its space.
  settled: boolean;
}

const NO_IMAGES: ImageContext = { images: new Map(), settled: true };

// A figure — web-ui's `Figure`, natively, with the same three states: the picture in
// a box of its stored aspect ratio (never wider than the image itself), the same box
// empty while the pack is on its way, or the words when there is no kept image.
function FigureBlock({ block, context }: { block: ReaderBlock; context: ImageContext }) {
  const runs = block.runs ?? [];
  const { width, height } = block;
  const sized =
    typeof block.image === 'string' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    width > 0 &&
    height > 0;
  const view = sized ? context.images.get(block.image as string) : undefined;

  if (sized && (view || !context.settled)) {
    return (
      <View className="my-4">
        <View
          className="w-full self-center overflow-hidden rounded-lg bg-muted"
          style={{ aspectRatio: (width as number) / (height as number), maxWidth: width }}
        >
          {view ? (
            <ExpoImage
              source={{ uri: view.uri }}
              contentFit="contain"
              style={{ width: '100%', height: '100%' }}
              accessibilityLabel={block.text || undefined}
              accessible={Boolean(block.text)}
              testID="reader-figure-image"
            />
          ) : null}
        </View>
        {runs.length > 0 ? (
          <Text selectable className="mt-2 text-sm text-muted-foreground">
            <Runs runs={runs} />
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className="my-4 flex-row items-start gap-3 rounded-lg border border-dashed border-border px-4 py-3">
      <Icon as={ImageOff} className="mt-0.5 size-4 text-muted-foreground" />
      <View className="min-w-0 flex-1">
        <Text selectable className="text-sm">
          {block.text || 'Image not kept'}
        </Text>
        {runs.length > 0 ? (
          <Text selectable className="mt-1 text-sm text-muted-foreground">
            <Runs runs={runs} />
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Block({
  block,
  rtl,
  number,
  context,
}: {
  block: ReaderBlock;
  rtl: boolean;
  number?: number;
  context: ImageContext;
}) {
  const runs = block.runs ?? [];
  const textStyle = { writingDirection: rtl ? ('rtl' as const) : ('ltr' as const) };
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(Math.max(block.level ?? 1, 1), 3);
      return (
        <Text
          selectable
          accessibilityRole="header"
          style={textStyle}
          className={cn('mt-6 mb-2 leading-snug', HEADING_CLASS[level])}
        >
          <Runs runs={runs} />
        </Text>
      );
    }
    case 'paragraph':
      return (
        <Text selectable style={textStyle} className="my-3 text-[17px] leading-7">
          <Runs runs={runs} />
        </Text>
      );
    case 'quote':
      return (
        <View className="my-3 border-l-2 border-border pl-4">
          <Text
            selectable
            style={textStyle}
            className="text-[17px] leading-7 text-muted-foreground"
          >
            <Runs runs={runs} />
          </Text>
        </View>
      );
    case 'listItem': {
      const depth = Math.max(0, block.level ?? 0);
      return (
        <View className="my-1 flex-row gap-2" style={{ paddingStart: 8 + depth * 20 }}>
          <Text className="text-[17px] leading-7 text-muted-foreground" accessibilityElementsHidden>
            {block.ordered ? `${number ?? 1}.` : '•'}
          </Text>
          <Text selectable style={textStyle} className="flex-1 text-[17px] leading-7">
            <Runs runs={runs} />
          </Text>
        </View>
      );
    }
    case 'code':
      return (
        <View className="my-3 rounded-lg bg-muted p-3">
          <Text selectable className="font-mono text-sm leading-6">
            {block.text ?? ''}
          </Text>
        </View>
      );
    case 'figure':
      return <FigureBlock block={block} context={context} />;
    case 'table':
      return <TableBlock block={block} rtl={rtl} />;
    case 'rule':
      return <View className="my-6 h-px bg-border" />;
    default:
      return null;
  }
}

// Ordered list items carry no number in the copy — web gets one from its `<ol>`;
// here each run of consecutive ordered items at one depth is counted from 1.
function numberOrderedItems(blocks: ReaderBlock[]): { block: ReaderBlock; number?: number }[] {
  let count = 0;
  let prev: ReaderBlock | undefined;
  return blocks.map((block) => {
    const ordered = block.kind === 'listItem' && block.ordered === true;
    const continues =
      ordered && prev?.kind === 'listItem' && prev.ordered === true && prev.level === block.level;
    count = ordered ? (continues ? count + 1 : 1) : 0;
    prev = block;
    return ordered ? { block, number: count } : { block };
  });
}

export function ReaderArticle({
  doc,
  title,
  meta,
  images,
  imagesSettled,
}: {
  doc: ReaderDoc;
  title: string;
  meta?: string;
  // The copy's kept images by key, and whether the pack has been read yet. Absent:
  // every figure is its words.
  images?: ReadonlyMap<string, ReaderArticleImage>;
  imagesSettled?: boolean;
}) {
  const context: ImageContext = images ? { images, settled: imagesSettled ?? true } : NO_IMAGES;
  const rtl = doc.dir === 'rtl';
  return (
    <View>
      <Text selectable accessibilityRole="header" className="text-2xl leading-tight font-semibold">
        {title}
      </Text>
      {meta ? <Text className="mt-2 mb-4 text-sm text-muted-foreground">{meta}</Text> : null}
      {numberOrderedItems(doc.blocks).map(({ block, number }) => (
        <Block key={block.id} block={block} rtl={rtl} number={number} context={context} />
      ))}
    </View>
  );
}
