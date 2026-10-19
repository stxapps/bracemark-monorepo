// The fixed-height budget, as arithmetic: does a line of text still fit inside
// the box that pins its height, at the app's 1.3 font-scale cap?
//
// WHY THIS EXISTS. Every Tailwind box dimension is dp and does not scale while
// the text inside it does, up to lib/font-scale.ts's 1.3 — so a box whose `h-*`
// minus its vertical padding and borders leaves exactly one line at 1× clips
// that line for anyone who has touched the OS text-size setting. It happened
// three times, each time split across TWO components so that no one file held
// the whole sum: Button's `h-10` against its own `py-2` with the label's size
// arriving by TextClassContext; TabsList's `h-9 p-[3px]` against TabsTrigger's
// `border py-1`; and a call site's `h-8 text-sm` against Input's base `py-1`
// (docs/theme.md, _extending_, carries all three). Nothing reports it — jest
// lays nothing out, the accessibility tree is perfect, and on screen it is a
// few missing pixels of descender that only show with the setting raised.
//
// So this reads the classes that reach the HOST nodes — after every `cn` merge,
// variant and context, which is the only place the whole sum exists — and does
// the sum. It is a NECESSARY condition, not a layout engine: one line per Text,
// no flex arithmetic, no wrapping. A box it passes can still clip in ways only
// a device shows (docs/e2e.md, _visual checkpoints_); a box it fails clips.
//
// Only classes that apply on a phone held upright count. An unprefixed class,
// or one under `native:`/`ios:`/`android:`, applies; `web:`, `dark:`, `active:`
// and the breakpoints do not. `sm:`/`md:` DO fire on a tablet or a phone on
// its side, and skipping them is sound only because no breakpoint in the app
// sizes a box or a type step any more — the controls' `sm:` height steps went
// with the tablet layout (ui/input.tsx), and what is left (`md:px-6`, the `sm:`
// row in sync-paused-notice.tsx) moves boxes without shrinking them. A
// breakpoint that sets a height, a vertical padding or a `text-*` makes this
// a phone-only check, and it would have to sum the wide variant too.

import { MAX_FONT_SIZE_MULTIPLIER } from '../lib/font-scale';

const PHONE_VARIANTS = new Set(['native', 'ios', 'android']);

// Inter's natural line box: what a Text with no leading lays out at, and what
// iOS gives a single-line TextInput whatever it is passed (ui/input.tsx).
const INTER_NATURAL = 1.21;

// Tailwind v4's `text-*` steps, each paired with its own line height.
const TEXT_STEPS: Record<string, [font: number, line: number]> = {
  xs: [12, 16],
  sm: [14, 20],
  base: [16, 24],
  lg: [18, 28],
  xl: [20, 28],
  '2xl': [24, 32],
  '3xl': [30, 36],
  '4xl': [36, 40],
};

const LEADING_FACTORS: Record<string, number> = {
  none: 1,
  tight: 1.25,
  snug: 1.375,
  normal: 1.5,
  relaxed: 1.625,
  loose: 2,
};

function phoneUtilities(className: string): string[] {
  return className
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((raw) => {
      const parts = raw.split(':');
      const utility = parts.pop() as string;
      return parts.every((p) => PHONE_VARIANTS.has(p)) ? [utility] : [];
    });
}

// A spacing-scale value (`9`, `0.5`, `px`, `[3px]`) in dp; undefined for
// anything that isn't a fixed length (`auto`, `full`, `1/2`, `[50%]`).
function spacing(value: string): number | undefined {
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 4;
  if (value === 'px') return 1;
  const arbitrary = /^\[(\d+(\.\d+)?)px\]$/.exec(value);
  return arbitrary ? Number(arbitrary[1]) : undefined;
}

// A border width (`border` is 1, `border-2` is 2 — px, not the spacing scale);
// undefined for a colour (`border-input`), which says nothing about width.
function borderWidth(value: string | undefined): number | undefined {
  if (value === undefined) return 1;
  if (/^\d+$/.test(value)) return Number(value);
  const arbitrary = /^\[(\d+(\.\d+)?)px\]$/.exec(value);
  return arbitrary ? Number(arbitrary[1]) : undefined;
}

export interface Box {
  // The pinned height, if any. `min-h-*` does not pin: it is the fix.
  height?: number;
  // Vertical padding plus vertical borders — what the box takes from its own
  // height before its content gets any.
  inset: number;
  // Taken out of flow (`absolute`) — a parent's height doesn't bound it.
  outOfFlow: boolean;
  // Paints nothing (`sr-only`), so it has nothing to clip.
  hidden: boolean;
}

export function parseBox(className: string): Box {
  let height: number | undefined;
  let padTop = 0;
  let padBottom = 0;
  let borderTop = 0;
  let borderBottom = 0;
  let outOfFlow = false;
  let hidden = false;
  for (const u of phoneUtilities(className)) {
    let m: RegExpExecArray | null;
    if ((m = /^(?:h|size)-(.+)$/.exec(u))) {
      height = spacing(m[1]);
    } else if ((m = /^p(y|t|b)?-(.+)$/.exec(u))) {
      const v = spacing(m[2]);
      if (v === undefined) continue;
      if (m[1] !== 'b') padTop = v;
      if (m[1] !== 't') padBottom = v;
    } else if ((m = /^border(?:-(y|t|b))?(?:-(.+))?$/.exec(u))) {
      const v = borderWidth(m[2]);
      if (v === undefined) continue;
      if (m[1] !== 'b') borderTop = v;
      if (m[1] !== 't') borderBottom = v;
    } else if (u === 'absolute') {
      outOfFlow = true;
    } else if (u === 'sr-only') {
      hidden = true;
    }
  }
  return { height, inset: padTop + padBottom + borderTop + borderBottom, outOfFlow, hidden };
}

// The line box one line of this text needs, at 1×: its leading, but never less
// than Inter's natural box. A leading tighter than the font still paints the
// glyphs at their full height, and a single-line TextInput on iOS drops its
// leading for the natural box anyway (ui/input.tsx) while Android draws it.
export function lineHeight(className: string): number {
  let font = 14; // React Native's own default, before any class
  let stepLine: number | undefined;
  let leading: number | undefined;
  let leadingFactor: number | undefined;
  for (const u of phoneUtilities(className)) {
    let m: RegExpExecArray | null;
    if ((m = /^text-(xs|sm|base|lg|[234]?xl)$/.exec(u))) {
      [font, stepLine] = TEXT_STEPS[m[1]];
    } else if ((m = /^text-\[(\d+(\.\d+)?)px\]$/.exec(u))) {
      font = Number(m[1]);
      stepLine = undefined;
    } else if ((m = /^leading-(.+)$/.exec(u))) {
      if (m[1] in LEADING_FACTORS) {
        leadingFactor = LEADING_FACTORS[m[1]];
        leading = undefined;
      } else {
        leading = spacing(m[1]);
        leadingFactor = undefined;
      }
    }
  }
  const natural = font * INTER_NATURAL;
  // An explicit `leading-*` beats the size step's own, whatever the order —
  // as it does in Tailwind's CSS, where the leading utilities come later.
  const line =
    leading ?? (leadingFactor !== undefined ? font * leadingFactor : (stepLine ?? natural));
  return Math.max(line, natural);
}

// How far this node's text can scale: the cap it carries, or none if scaling is
// off (the iOS share-extension process — lib/font-scale.ts).
export function fontScale(props: Record<string, unknown>): number {
  if (props.allowFontScaling === false) return 1;
  const own = props.maxFontSizeMultiplier;
  return typeof own === 'number' && own > 0
    ? Math.min(own, MAX_FONT_SIZE_MULTIPLIER)
    : MAX_FONT_SIZE_MULTIPLIER;
}

export interface Violation {
  where: string;
  className: string;
  room: number;
  needs: number;
}

export function formatViolation(v: Violation): string {
  return `${v.where}: ${v.needs.toFixed(1)}dp line in ${v.room.toFixed(1)}dp of room — "${v.className}"`;
}

type HostNode = { type: string; props: Record<string, unknown>; children?: unknown[] | null };

// Walk a rendered host tree (`render(ui).toJSON()`), carrying the room left
// inside the nearest pinned-height ancestor, and report every Text/TextInput
// whose line at the cap is taller than that room.
export function checkRendered(tree: unknown, where: string): Violation[] {
  const found: Violation[] = [];
  const visit = (node: unknown, room: number | undefined) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, room));
    const n = node as HostNode;
    const className = typeof n.props.className === 'string' ? n.props.className : '';
    const box = parseBox(className);
    if (box.hidden) return;
    let inner = box.outOfFlow ? undefined : room;
    if (box.height !== undefined) inner = box.height;
    if (inner !== undefined) inner -= box.inset;
    if (n.type === 'Text' || n.type === 'TextInput') {
      const needs = lineHeight(className) * fontScale(n.props);
      if (inner !== undefined && needs > inner + 0.01) {
        found.push({ where, className, room: inner, needs });
      }
      return; // a nested Text is an inline span of this one's line
    }
    n.children?.forEach((c) => visit(c, inner));
  };
  visit(tree, undefined);
  return found;
}
