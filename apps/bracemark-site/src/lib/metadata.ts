import type { Metadata, ResolvingMetadata } from 'next';

import { SOCIAL } from '@stxapps/shared';

import { SITE_URL } from './site';

type PageMetadata = {
  /** The page's own title. The root layout's template makes the tab title. */
  title: string;
  description: string;
  /** The clean URL, exactly as `app/sitemap.ts` lists it. */
  path: string;
  /** Present for a blog post: its card is an `article`, with its times. */
  article?: { publishedTime: string; modifiedTime?: string };
};

/**
 * A page's canonical and its social card, every one of them naming the page
 * itself. Every page except `/` builds its metadata here; `/` inherits the root
 * layout's card, which is its own.
 *
 * Why one function rather than fields typed per page: Next merges metadata
 * down the tree ONE LEVEL deep. A page that sets no `openGraph` inherits the
 * layout's whole object, `url` included, and every shared link to it becomes a
 * card for the home page: its title, its description, its address. A page that
 * does set one replaces the layout's whole object, including the card images,
 * which are file conventions beside the root layout and so live in that object
 * too. Hence `parent`: the images are carried through from it, and nothing else is.
 *
 * `app/sitemap.spec.ts` holds each listed page's canonical and `og:url` to its
 * sitemap URL.
 */
export async function pageMetadata(
  parent: ResolvingMetadata,
  { title, description, path, article }: PageMetadata,
): Promise<Metadata> {
  const url = `${SITE_URL}${path}`;
  const socialTitle = `${title} · Bracemark`;
  const inherited = await parent;
  const card = {
    title: socialTitle,
    description,
    url,
    siteName: 'Bracemark',
    images: inherited.openGraph?.images,
  };

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: article
      ? {
          ...card,
          type: 'article',
          publishedTime: article.publishedTime,
          ...(article.modifiedTime && { modifiedTime: article.modifiedTime }),
        }
      : { ...card, type: 'website' },
    twitter: {
      title: socialTitle,
      description,
      card: 'summary_large_image',
      site: SOCIAL.handle,
      images: inherited.twitter?.images,
    },
  };
}
