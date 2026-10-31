import { Fragment, type ReactNode } from 'react';
import { ImageOff } from 'lucide-react';

import { isReaderHref, type ReaderBlock, type ReaderDoc, type ReaderRun } from '@stxapps/shared';

import { cn } from '../../lib/utils';

// A read-mode copy, rendered — the web half of docs/reader.md's _rendering — text
// nodes only_. The copy is a list of plain-string blocks (`@stxapps/shared`
// reader/reader-doc.ts), and this component's one job is to keep it that way:
//
//   - every string reaches the DOM as a React CHILD, so it is a text node. There is
//     no `dangerouslySetInnerHTML` here and there must never be one — the copy is
//     a stranger's page, rendered in the origin that holds the data key
//     (docs/link-extraction-keep.md, the format tripwire);
//   - a link is an `<a>` only when `isReaderHref` passes at RENDER time too (a
//     backup is an outside file), and it leaves for a new tab with no referrer —
//     the saved site learns nothing about where it was read;
//   - a figure is a placeholder: the copy keeps no image bytes and never the URL,
//     so nothing here can make a request;
//   - a block kind this version doesn't know renders nothing, and the rest of the
//     document still renders — a newer client's copy must not blank this screen.
//
// Lives in web-ui, not in bracemark-web, so the browser extension can show a copy
// with the same component if it ever grows a reader.

// The page's own `<h1>` is the article title the reader prints above the blocks,
// so the copy's levels shift down one: 1 → h2, 2 → h3, anything deeper → h4. A
// screen reader's heading outline then has one top, and it is the title.
const HEADING_TAGS = ['h2', 'h3', 'h4'] as const;

function runsOf(block: ReaderBlock): ReaderRun[] {
  return block.runs ?? [];
}

function Run({ run }: { run: ReaderRun }) {
  let node: ReactNode = run.text;
  if (run.code) {
    node = (
      <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]')}>{node}</code>
    );
  }
  if (run.italic) node = <em>{node}</em>;
  if (run.bold) node = <strong className={cn('font-semibold')}>{node}</strong>;
  if (isReaderHref(run.href)) {
    node = (
      <a
        href={run.href}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        className={cn(
          'underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground',
        )}
      >
        {node}
      </a>
    );
  }
  return node;
}

// `whitespace-pre-line` keeps the line breaks a `<br>` became in the capture and
// collapses everything else, which is what the capture already did to it.
function Runs({ runs }: { runs: ReaderRun[] }) {
  return (
    <>
      {runs.map((run, i) => (
        <Run key={i} run={run} />
      ))}
    </>
  );
}

// Consecutive list items become ONE list per run of the same kind and depth —
// the copy stores items flat (a `level` per item), and a screen reader announces
// "list, 4 items" only for a real `<ul>`/`<ol>`. Depth is shown by indent.
// A wrapper rather than a union with ReaderBlock itself: a block is a looseObject,
// so a future kind may carry any key, and `'items' in x` must not mistake it.
type Group =
  | { type: 'list'; ordered: boolean; level: number; items: ReaderBlock[] }
  | { type: 'block'; block: ReaderBlock };

function group(blocks: ReaderBlock[]): Group[] {
  const out: Group[] = [];
  for (const block of blocks) {
    if (block.kind !== 'listItem') {
      out.push({ type: 'block', block });
      continue;
    }
    const ordered = block.ordered === true;
    const level = Math.max(0, block.level ?? 0);
    const last = out[out.length - 1];
    if (last?.type === 'list' && last.ordered === ordered && last.level === level) {
      last.items.push(block);
    } else {
      out.push({ type: 'list', ordered, level, items: [block] });
    }
  }
  return out;
}

function Block({ block }: { block: ReaderBlock }) {
  const runs = runsOf(block);
  switch (block.kind) {
    case 'heading': {
      const Tag = HEADING_TAGS[Math.min(Math.max((block.level ?? 1) - 1, 0), 2)];
      return (
        <Tag className={cn('mt-8 mb-3 text-xl leading-snug font-semibold text-foreground')}>
          <Runs runs={runs} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p className={cn('my-4 whitespace-pre-line')}>
          <Runs runs={runs} />
        </p>
      );
    case 'quote':
      return (
        <blockquote
          className={cn(
            'my-4 border-l-2 border-border pl-4 whitespace-pre-line text-muted-foreground',
          )}
        >
          <Runs runs={runs} />
        </blockquote>
      );
    case 'code':
      return (
        <pre
          className={cn('my-4 overflow-x-auto rounded-lg bg-muted p-4 font-mono text-sm leading-6')}
        >
          <code>{block.text ?? ''}</code>
        </pre>
      );
    case 'figure':
      return (
        <figure
          className={cn(
            'my-6 flex items-start gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground',
          )}
        >
          <ImageOff className={cn('mt-0.5 size-4 shrink-0')} aria-hidden="true" />
          <div className={cn('min-w-0')}>
            {/* The alt text stands in for the picture; the caption, if any, is
                what the page printed under it. "Image not kept" is the honest
                label when there is neither. */}
            <p className={cn('text-foreground')}>{block.text || 'Image not kept'}</p>
            {runs.length > 0 && (
              <figcaption className={cn('mt-1 whitespace-pre-line')}>
                <Runs runs={runs} />
              </figcaption>
            )}
          </div>
        </figure>
      );
    case 'rule':
      return <hr className={cn('my-8 border-border')} />;
    default:
      return null;
  }
}

export function ReaderArticle({
  doc,
  title,
  meta,
}: {
  doc: ReaderDoc;
  // What the reader prints as the article's `<h1>` — the caller resolves it (the
  // link's own title wins over the copy's, the same override rule as everywhere).
  title: string;
  // A line under the title: site, byline, when it was kept. Plain text.
  meta?: ReactNode;
}) {
  const dir = doc.dir === 'rtl' ? 'rtl' : 'ltr';
  return (
    <article
      lang={doc.lang}
      dir={dir}
      className={cn('text-[1.0625rem] leading-7 break-words text-foreground/90')}
    >
      <header className={cn('mb-6')}>
        <h1 className={cn('text-2xl leading-tight font-semibold text-foreground md:text-3xl')}>
          {title}
        </h1>
        {meta ? <p className={cn('mt-3 text-sm text-muted-foreground')}>{meta}</p> : null}
      </header>
      {group(doc.blocks).map((item) => {
        if (item.type === 'list') {
          const List = item.ordered ? 'ol' : 'ul';
          return (
            <List
              key={item.items[0].id}
              className={cn('my-4 space-y-1.5', item.ordered ? 'list-decimal' : 'list-disc')}
              style={{ paddingInlineStart: `${1.5 + item.level * 1.5}rem` }}
            >
              {item.items.map((block) => (
                <li key={block.id} className={cn('pl-1 whitespace-pre-line')}>
                  <Runs runs={runsOf(block)} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <Fragment key={item.block.id}>
            <Block block={item.block} />
          </Fragment>
        );
      })}
    </article>
  );
}
