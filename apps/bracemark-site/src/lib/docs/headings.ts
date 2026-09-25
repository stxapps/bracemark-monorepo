// Heading ids for /docs, and the rehype plugin that stamps them.
//
// Deliberately free of imports. The id rule has two callers that must agree: the
// plugin, which runs inside the MDX compile at build time, and `docs.spec.ts`,
// which recomputes the ids from the SOURCE lines to check every `/docs/…#anchor`
// link. The spec cannot run the compile — `@mdx-js/mdx` and the unified stack
// under it are ESM-only, dozens of packages deep, and jest would need every one
// of them on its transform allowlist — so it reads `## ` lines instead. That is
// only sound while a heading's source text IS its rendered text, which is why the
// spec also holds headings to plain text: no code spans, emphasis, links or JSX.

export type DocHeading = { id: string; text: string; depth: 2 | 3 };

/**
 * The id for a heading's text, unique within one page. `seen` carries the counts
 * across calls, so pass one Map per page and walk headings in document order.
 * Apostrophes are dropped rather than hyphenated, so “you’ve” reads `youve`.
 */
export function headingId(text: string, seen: Map<string, number>): string {
  const base =
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section';
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

// The slice of a hast node this plugin reads. Typed locally rather than from
// `@types/hast`, which is only a transitive dependency here.
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/**
 * Gives every h2 and h3 an id and appends it to `collected`, in document order.
 * The h2s are the page's "On this page" list; the h3s get ids so they can be
 * linked to, and share the counter so an h3 can't collide with an h2.
 */
export function rehypeHeadingIds(collected: DocHeading[]) {
  return (tree: HastNode) => {
    const seen = new Map<string, number>();
    const walk = (node: HastNode) => {
      if (node.type === 'element' && (node.tagName === 'h2' || node.tagName === 'h3')) {
        const text = textOf(node);
        const id = headingId(text, seen);
        node.properties = { ...node.properties, id };
        collected.push({ id, text, depth: node.tagName === 'h2' ? 2 : 3 });
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
