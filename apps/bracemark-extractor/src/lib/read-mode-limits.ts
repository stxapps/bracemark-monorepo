import { Parser } from 'htmlparser2';

// The checks that run BEFORE Readability (read-mode.ts, `readModeOrThrow`, has the map of all three
// costs): a pass of the parser over the string, then a walk of the parsed tree. Each refuses a page
// whose shape is slow on its own, before the work that shape would make slow has started.

export const MAX_READ_MODE_DEPTH = 256;
export const MAX_READ_MODE_ELEMENTS = 60_000;
export const MAX_READ_MODE_COST = 40_000_000;
// Nodes the parser may emit other than elements before the page is refused: text runs and comments,
// each of which becomes a node linkedom builds and Readability walks — super-linearly when they
// share a parent (240,000 in one `<p>` took 4 s on Node; 60,000, 0.7 s) — and processing
// instructions (a doctype), which linkedom keeps as no node but which cost the parser the same.
// htmlparser2 emits a text run per decoded entity, so a megabyte of `&amp;` is 200,000 of them. The
// heaviest local page has 19,000.
export const MAX_READ_MODE_NODES = 60_000;

// Thrown out of the parser's own callbacks to stop it at the first limit crossed.
class ReadModeLimit extends Error {}

// Is the page inside the limits, as the parser linkedom uses would build it? One pass of
// htmlparser2 with the options linkedom gives it (linkedom/esm/shared/parse-from-string.js),
// building no tree: every element the parser opens is an `onopentagname` and every one it closes,
// stated or implied, an `onclosetag`, so the depth counted here is the depth linkedom's tree will
// have. Run BEFORE `parseHTML`, which is what it protects.
export function withinReadModeMarkup(html: string): boolean {
  let depth = 0;
  let elements = 0;
  let nodes = 0;
  const other = () => {
    if (++nodes > MAX_READ_MODE_NODES) throw new ReadModeLimit();
  };
  const parser = new Parser(
    {
      onopentagname() {
        if (++depth > MAX_READ_MODE_DEPTH || ++elements > MAX_READ_MODE_ELEMENTS) {
          throw new ReadModeLimit();
        }
      },
      onclosetag() {
        depth--;
      },
      ontext: other,
      oncomment: other,
      onprocessinginstruction: other,
    },
    { lowerCaseAttributeNames: false, decodeEntities: true, xmlMode: false },
  );
  try {
    parser.write(html);
    parser.end();
    return true;
  } catch (err) {
    if (err instanceof ReadModeLimit) return false;
    throw err;
  }
}

// Is this parsed document inside those bounds? One iterative walk (no recursion: the page chooses
// the depth), stopping at the first element that crosses one.
//
// The cost weighs NODES, not elements. linkedom keeps an element's attributes in the same linked
// list as its children, and text runs and comments are nodes too, so every subtree walk Readability
// makes steps through all of them: 240 nested `<div>`s around one `<p>` with 5,000 attributes took
// 2.7 s on Node, though its elements cost almost nothing. So each element adds its depth squared
// times (1 + its attributes + its children that are not elements), and each parent adds its element
// children times (all its child nodes + its attributes), the width term Readability's sibling loop
// pays for; and each element ATTRIBUTE_COPY_WEIGHT times its attributes squared, the one copy
// `_setNodeTag` makes when Readability renames it. A PREDICTION of one pass of Readability, refusing
// the shapes that are slow on their own before any of it runs; what Readability repeats — per
// ancestor, per attempt — is counted by the meter as it happens (read-mode-meter.ts).
export function withinReadModeBounds(root: WalkedNode): boolean {
  return readModeWalkCost(root) !== null;
}

// The walk's cost, or null past a limit (it stops at the first element that crosses one).
export function readModeWalkCost(root: WalkedNode): number | null {
  const stack: { el: WalkedNode; depth: number }[] = [];
  let count = 0;
  let cost = 0;
  // Pushes `parent`'s element children and charges its width; returns how many of its child nodes
  // are not elements, or -1 past a limit.
  const push = (parent: WalkedNode, depth: number, attributes: number): number => {
    let children = 0;
    for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
      stack.push({ el: c, depth });
      if (++children > MAX_READ_MODE_ELEMENTS) return -1;
    }
    const nodes = parent.childNodes.length;
    cost += children * (nodes + attributes);
    return cost > MAX_READ_MODE_COST ? -1 : nodes - children;
  };
  if (push(root, 1, 0) < 0) return null;
  while (stack.length > 0) {
    const { el, depth } = stack.pop() as { el: WalkedNode; depth: number };
    const attributes = el.attributes?.length ?? 0;
    const other = push(el, depth + 1, attributes);
    if (other < 0) return null;
    cost +=
      depth * depth * (1 + attributes + other) + ATTRIBUTE_COPY_WEIGHT * attributes * attributes;
    if (
      depth > MAX_READ_MODE_DEPTH ||
      ++count > MAX_READ_MODE_ELEMENTS ||
      cost > MAX_READ_MODE_COST
    ) {
      return null;
    }
  }
  return cost;
}

// An attribute pair in Readability's copy loops (`_setNodeTag`: rebuild the list, read one, look the
// name up on the target) against a unit of the walk's: 40,000 attributes on one `<div>`, 1.6e9 pairs,
// took 135 s in workerd, about 84 ns a pair; the walk's heaviest unit is about 60 ns.
const ATTRIBUTE_COPY_WEIGHT = 2;

// What the walk reads of linkedom's document and elements.
export type WalkedNode = {
  firstElementChild: WalkedNode | null;
  nextElementSibling: WalkedNode | null;
  childNodes: { length: number };
  attributes?: { length: number };
};
