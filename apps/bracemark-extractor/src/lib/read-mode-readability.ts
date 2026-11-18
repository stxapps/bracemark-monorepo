import { Readability } from '@mozilla/readability';

import { spend } from './read-mode-meter';

// Readability's work inside one string — a regex that retries from every character, every word of a
// title compared with every word of a heading, a wrapper's attributes copied down a chain — made
// linear before or while it runs (read-mode.ts, `readModeOrThrow`, has the map of the costs).

// Whatever Readability's declarations call a document — lib.dom's `Document`, which
// this tsconfig doesn't load, so it's named through the constructor instead.
export type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// Readability with two of its own methods made linear. Both are Readability's internals, not its
// API, so a spec fails if an upgrade stops having them.
//
// - `_textSimilarity` checks each word of one text against every word of the other
//   (`Array.includes`), and it compares the article title with every `<h1>` and `<h2>`: a 960 KB
//   `og:title` against an `<h2>` of other words took 55 s. The same answer from a Set, with the
//   title's words kept between calls.
// - `_simplifyNestedElements` replaces a `<div>` or `<section>` that only wraps another with that
//   child, copying the wrapper's attributes onto it one by one (each copy rebuilds linkedom's list),
//   and goes on down: a chain carries every wrapper's attributes above it, each level paying their
//   count squared (276 wrappers of 250 attributes over 20-deep chains: 32 s). Nothing after it reads
//   a wrapper's attributes — Readability only strips classes, and the walker reads links, images and
//   table cells — so they are removed first, each in one step, and the chain has none to carry.
//   (That includes the id of Readability's own `readability-page-1` wrapper, which the method spares;
//   simplified, it leaves the same text.)
export class LinearReadability extends Readability {
  // What one more pass of the page costs, in the meter's units: the walk's own prediction
  // (withinReadModeBounds), which has already admitted ONE pass.
  constructor(
    document: ReadabilityDocument,
    private readonly passCost: number,
  ) {
    super(document);
  }

  private similarityText?: string;
  private similarityWords = new Set<string>();

  _textSimilarity(textA: string, textB: string): number {
    if (textA !== this.similarityText) {
      this.similarityText = textA;
      this.similarityWords = new Set(words(textA));
    }
    return similarity(this.similarityWords, words(textB));
  }

  // Readability's retry: when the article it found is under 500 characters it drops a flag and runs
  // the whole of `_grabArticle` again, up to three more times, and this is the one place it does.
  // The node walks of each extra pass are what the walk check predicted for one; the meter counts
  // the reads, not the walks, so each retry is charged the prediction (a page that passed the walk
  // at its cap and forced every retry would otherwise run four passes).
  _removeFlag(flag: number): void {
    spend(this.passCost);
    readabilityMethod('_removeFlag').call(this, flag);
  }

  _simplifyNestedElements(articleContent: DefusedElement): void {
    const wrappers = articleContent.querySelectorAll('div, section') as ArrayLike<DefusedElement>;
    for (const wrapper of [articleContent, ...Array.from(wrappers)]) {
      for (const { name } of Array.from(wrapper.attributes)) wrapper.removeAttribute(name);
    }
    readabilityMethod('_simplifyNestedElements').call(this, articleContent);
  }
}

// One of Readability's own methods, by name, for an override to call through to.
export function readabilityMethod(name: string): (this: unknown, ...args: unknown[]) => unknown {
  return (Readability.prototype as unknown as Record<string, never>)[name];
}

const words = (text: string) => text.toLowerCase().split(/\W+/).filter(Boolean);

// Readability's `_textSimilarity`, with `tokensA.includes` replaced by a Set lookup.
export function textSimilarity(textA: string, textB: string): number {
  return similarity(new Set(words(textA)), words(textB));
}

function similarity(wordsA: Set<string>, wordsB: string[]): number {
  if (wordsA.size === 0 || wordsB.length === 0) return 0;
  const unique = wordsB.filter((word) => !wordsA.has(word));
  return 1 - unique.join(' ').length / wordsB.join(' ').length;
}

// The strings Readability runs a backtracking regex over, made safe before it runs, with the
// answer each regex would give unchanged where it can be and the attribute dropped where not:
//
// - `<meta property>`: Readability matches `/\s*(article|…)\s*:…/g`, unanchored, so a long run of
//   whitespace costs its length squared. Each run becomes one space, which every `\s*` in it
//   matches the same way, and Readability strips the whitespace from what it keeps anyway.
// - `srcset`, and an image's lazy-loading attribute that Readability would copy into one: its
//   `srcsetUrl` regex retries from every character of a run whose end it can't match (81 KB: 24 s).
//   `srcsetBacktracks` follows the regex's own scan and says whether it reaches such a run; an
//   honest srcset never does, and an image without one keeps its `src`.
// - Another lazy-loading attribute: `/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/` tries every extension
//   in the first word of a value of several words, each to the end of that word.
export function defuseForReadability(document: {
  querySelectorAll(selector: string): unknown;
}): void {
  const all = (selector: string) =>
    Array.from(document.querySelectorAll(selector) as ArrayLike<DefusedElement>);
  for (const meta of all('meta[property]')) {
    const property = meta.getAttribute('property') ?? '';
    const collapsed = property.replace(/\s+/g, ' ');
    if (collapsed !== property) meta.setAttribute('property', collapsed);
  }
  for (const media of all(MEDIA)) {
    const lazy = LAZY_IMAGE.has(media.tagName);
    for (const { name, value } of Array.from(media.attributes)) {
      if (name === 'src' || name === 'alt') continue;
      const copiedAsSrcset = name === 'srcset' || (lazy && LAZY_SRCSET.test(value));
      if (copiedAsSrcset ? srcsetBacktracks(value) : lazy && lazySrcBacktracks(value)) {
        media.removeAttribute(name);
      }
    }
  }
}

// What the pass reads and writes of linkedom's elements.
type DefusedElement = {
  tagName: string;
  querySelectorAll(selector: string): unknown;
  attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};
const MEDIA = 'img, picture, figure, video, audio, source';
// The elements `_fixLazyImages` reads attributes of, and its two tests on each value.
const LAZY_IMAGE = new Set(['IMG', 'PICTURE', 'FIGURE']);
const LAZY_SRCSET = /\.(jpg|jpeg|png|webp)\s+\d/;
const LAZY_SRC_EXTENSION = /\.(jpg|jpeg|png|webp)/g;
const LAZY_SRC_MAX_EXTENSIONS = 8;

// Does Readability's `/(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g` meet a run it retries from every
// character? Its scan, run once: from each run of non-space, the match takes the whole run when what
// follows it matches the tail, and the regex goes on after the tail. When the tail fails, the match
// backs off to the run's last comma (`a.jpg, b.jpg` ends its first run in one), and every start
// after that comma fails, each reading to the run's end — so it is a retried run unless that comma
// ends the run.
export function srcsetBacktracks(srcset: string): boolean {
  const tail = /(?:\s+[\d.]+[xw])?\s*(?:,|$)/y;
  let at = 0;
  while (at < srcset.length) {
    while (at < srcset.length && /\s/.test(srcset[at])) at++;
    if (at >= srcset.length) return false;
    let end = at;
    while (end < srcset.length && !/\s/.test(srcset[end])) end++;
    tail.lastIndex = end;
    const match = tail.exec(srcset);
    if (match) at = end + match[0].length;
    else if (end - 1 > at && srcset[end - 1] === ',') at = end;
    else return true;
  }
  return false;
}

// `/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/` can only fail when the value is more than one word, and
// then it tries each extension in the first word to that word's end.
function lazySrcBacktracks(value: string): boolean {
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  if (space < 0) return false;
  const first = trimmed.slice(0, space);
  return (first.match(LAZY_SRC_EXTENSION)?.length ?? 0) > LAZY_SRC_MAX_EXTENSIONS;
}
