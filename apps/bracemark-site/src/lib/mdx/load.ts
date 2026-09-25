import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as runtime from 'react/jsx-runtime';
import { evaluate } from '@mdx-js/mdx';
import type { MDXContent } from 'mdx/types';
import remarkGfm from 'remark-gfm';

import { type Heading, rehypeHeadingIds } from './headings';

// Reads a /docs or /blog page and compiles it, at build time. Only server components
// call this, and under `output: 'export'` they run once, during `next build` — so
// the compiler, the file read and the `new Function` that `evaluate` runs the
// compiled module with all stay on the build machine. The page ships as HTML with
// no MDX runtime, and the apex CSP never sees an eval.
//
// `@mdx-js/mdx` rather than `@next/mdx` (docs/architecture.md, _the marketing
// site's `/docs`_): Next 16 builds with Turbopack, which takes remark/rehype
// plugins only as serializable strings, and `rehypeHeadingIds` is a function that
// hands its results back through a closure. Compiling here keeps plugins plain
// functions and next.config untouched.
//
// The path is from the working directory, not from this module: once built, this
// module lives under `.next/`, where a relative path finds nothing. Every target
// that renders the site — `nx build`, `nx dev` — runs with the project root as
// its cwd.
type Collection = 'docs' | 'blog';

export async function loadMdx(
  collection: Collection,
  slug: string,
): Promise<{ Content: MDXContent; headings: Heading[] }> {
  const source = await readFile(
    join(process.cwd(), 'src/content', collection, `${slug}.mdx`),
    'utf8',
  );
  const headings: Heading[] = [];
  const { default: Content } = await evaluate(source, {
    ...runtime,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [[rehypeHeadingIds, headings]],
  });
  return { Content, headings };
}
