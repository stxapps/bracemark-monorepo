import type { MDXComponents } from 'mdx/types';
import Link from 'next/link';

import { entitlementsOf } from '@stxapps/shared';

import { APP_URL } from '../../lib/site';

// Everything a /docs page may use beyond plain Markdown. The pages import nothing
// (docs.spec.ts holds that), so this map is the whole vocabulary, and a tag not
// in it fails the build rather than rendering blank.
//
// Plain elements are NOT restyled here: `.docs-prose` in globals.css styles
// h2/p/ul/table/code as a document, the way `.legal-prose` does for /terms and
// /privacy, so a page reads as Markdown to whoever edits it. The overrides are
// only for behaviour.

// An on-site path goes through next/link; anything else is a plain anchor. The
// app is NOT on-site — it is another origin, and next/link across origins is the
// mistake docs/hosting.md, _crossing an origin_, describes. `AppLink` below is
// how a page links into it.
function Anchor({ href = '', children, ...rest }: React.ComponentProps<'a'>) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    return <Link href={href}>{children}</Link>;
  }
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/**
 * A link into bracemark-web, e.g. `<AppLink path="/settings/data">Settings →
 * Data</AppLink>`. The origin differs per tier (APP_URL, lib/site.ts), which is
 * why a page can't type it.
 */
function AppLink({ path, children }: { path: string; children: React.ReactNode }) {
  return <a href={`${APP_URL}${path}`}>{children}</a>;
}

/** The free plan's link cap, read from the plan table rather than typed. */
function FreeLinks() {
  return entitlementsOf('free').maxLinks;
}

export const MDX_COMPONENTS: MDXComponents = {
  a: Anchor,
  AppLink,
  FreeLinks,
};
