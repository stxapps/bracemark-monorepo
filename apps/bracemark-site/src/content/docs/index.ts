// The /docs manifest: every page, its group, its order, and the title and
// description its <head> carries. The prose is `<slug>.mdx` beside this file.
//
// A TS module rather than a walk of this folder, for the reason app/sitemap.ts
// gives for its own hand-kept list: that module runs inside Next's build output,
// where the source tree is not where a relative path would look. An import
// resolves wherever it runs, so this one list feeds `generateStaticParams`, the
// sidebar, the prev/next links and the sitemap alike. `docs.spec.ts` beside it
// fails on a slug with no file and a file with no slug.
//
// Title and description live here rather than as frontmatter in the MDX because
// every consumer above needs them without compiling a page, and it spares the
// site a YAML parser.
//
// ORDER IS READING ORDER — the sidebar and prev/next follow it. A group earns its
// place when it has a page; there are no empty headings waiting for content (a
// placeholder prerenders as an indexable page, which is why the old /docs route
// was deleted until this one could ship with real pages).
//
// `description` is the meta description, so the same ~155-character budget as the
// one in app/layout.tsx: mechanism first, no call to action.

export type DocPage = { slug: string; title: string; description: string };
export type DocGroup = { title: string; pages: DocPage[] };

export const DOC_GROUPS: DocGroup[] = [
  {
    title: 'Your data',
    pages: [
      {
        slug: 'import',
        title: 'Import your links',
        description:
          'Bring links in from a browser, Raindrop.io, Pocket, LinkWarden, or a Bracemark backup: which file to use, what comes across, and what happens at your limit.',
      },
      {
        slug: 'export',
        title: 'Export your data',
        description:
          'Save your library as a Bracemark backup, an HTML bookmarks file, a CSV, or a list of URLs: what each one includes, and what every export leaves out.',
      },
    ],
  },
  {
    title: 'Account and security',
    pages: [
      {
        slug: 'lost-password',
        title: 'Lost your password',
        description:
          'Sign in with your recovery code and set a new password. How to replace a code you no longer trust, and what is left when both are gone.',
      },
    ],
  },
];

export const DOC_PAGES: DocPage[] = DOC_GROUPS.flatMap((group) => group.pages);

export function findDoc(slug: string): { page: DocPage; group: DocGroup } | undefined {
  for (const group of DOC_GROUPS) {
    const page = group.pages.find((candidate) => candidate.slug === slug);
    if (page) return { page, group };
  }
  return undefined;
}

/** The pages either side of `slug` in reading order, across group boundaries. */
export function docNeighbours(slug: string): { prev?: DocPage; next?: DocPage } {
  const index = DOC_PAGES.findIndex((page) => page.slug === slug);
  if (index === -1) return {};
  return { prev: DOC_PAGES[index - 1], next: DOC_PAGES[index + 1] };
}
