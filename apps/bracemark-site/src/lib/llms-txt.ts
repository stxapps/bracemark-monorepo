// /llms.txt — the site's own map, in the format llmstxt.org describes: one H1, a
// blockquote summary, then H2 sections of markdown links with a note each.
//
// Who reads it, honestly: not the AI search crawlers. Server-log studies through
// mid-2026 found almost none of them ever fetch the file, and no engine has said
// it uses one. What does fetch it is coding agents and documentation tools — an
// assistant asked "how do I import my Raindrop export into Bracemark" that looks
// here for the right page. So this is a convenience for them, never a ranking
// lever, and nothing on the site should claim otherwise.
//
// NOTHING IN HERE IS NEW COPY — the rule lib/structured-data.ts states for
// JSON-LD, for the same reason: a file machines read and nobody proofreads must
// not be where a sentence first appears. The summary is SITE_DESCRIPTION, the
// docs and blog entries are their manifests' titles and meta descriptions, and the
// site section is the footer's own labels. The only words of its own are the
// section headings. A better summary for a page is a better meta description on
// that page, which then lands here too.
//
// Absolute against SITE_URL in every tier, like the sitemap: these are the
// canonical addresses, and staging is never crawled (app/robots.ts).
//
// Not referenced from any page: `<link rel="llms">` is not part of the convention,
// and the agents that read the file look for it at this path.

import { BRAND } from '@stxapps/shared';

import { publishedBlogPosts } from '../content/blog';
import { DOC_GROUPS } from '../content/docs';
import { FOOTER_LINKS, SITE_DESCRIPTION, SITE_URL } from './site';

type Entry = { title: string; url: string; note?: string };

/** One markdown list item. Newlines would end the item, so none survive. */
function item({ title, url, note }: Entry): string {
  const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();
  return `- [${oneLine(title)}](${url})${note ? `: ${oneLine(note)}` : ''}`;
}

function section(heading: string, entries: Entry[]): string {
  return [`## ${heading}`, '', ...entries.map(item)].join('\n');
}

/** An absolute URL for a footer href, which is either a path or already absolute. */
function absolute(href: string): string {
  return href.startsWith('/') ? `${SITE_URL}${href}` : href;
}

export function llmsTxt(): string {
  const docs = DOC_GROUPS.map((group) =>
    section(
      `Docs: ${group.title}`,
      group.pages.map((page) => ({
        title: page.title,
        url: `${SITE_URL}/docs/${page.slug}`,
        note: page.description,
      })),
    ),
  );

  // The footer, in its own order, with each link once. It is the one list of the
  // site's pages that already exists as data — the top-level pages keep their
  // descriptions inside their own `generateMetadata`, which a route cannot import
  // without pulling the pages in with it.
  const seen = new Set<string>();
  const site = FOOTER_LINKS.flatMap((group) => group.links)
    .map((link) => ({ title: link.label, url: absolute(link.href) }))
    .filter((entry) => !seen.has(entry.url) && seen.add(entry.url));

  const blog = publishedBlogPosts().map((post) => ({
    title: post.title,
    url: `${SITE_URL}/blog/${post.slug}`,
    note: post.description,
  }));

  return [
    `# ${BRAND.name}`,
    '',
    `> ${SITE_DESCRIPTION}`,
    '',
    ...docs.flatMap((block) => [block, '']),
    section('Site', site),
    '',
    section('Blog', blog),
    '',
  ].join('\n');
}
