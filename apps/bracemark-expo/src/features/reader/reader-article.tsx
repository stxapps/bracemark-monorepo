import { Linking, View } from 'react-native';
import { ImageOff } from 'lucide-react-native';

import { isReaderHref, type ReaderBlock, type ReaderDoc, type ReaderRun } from '@stxapps/shared';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
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
//   - A figure is a placeholder; the copy keeps no image and never the URL.
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

function Block({ block, rtl, number }: { block: ReaderBlock; rtl: boolean; number?: number }) {
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
}: {
  doc: ReaderDoc;
  title: string;
  meta?: string;
}) {
  const rtl = doc.dir === 'rtl';
  return (
    <View>
      <Text selectable accessibilityRole="header" className="text-2xl leading-tight font-semibold">
        {title}
      </Text>
      {meta ? <Text className="mt-2 mb-4 text-sm text-muted-foreground">{meta}</Text> : null}
      {numberOrderedItems(doc.blocks).map(({ block, number }) => (
        <Block key={block.id} block={block} rtl={rtl} number={number} />
      ))}
    </View>
  );
}
