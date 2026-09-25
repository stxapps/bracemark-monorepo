import type { Metadata } from 'next';

import { SOCIAL } from '@stxapps/shared';

import { SITE_URL } from '../site';

/** The visible title and lede also supply page metadata and social previews. */
export function docsMetadata(title: string, description: string, path: string): Metadata {
  const socialTitle = `${title} · Bracemark`;
  const url = `${SITE_URL}${path}`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: socialTitle,
      description,
      url,
      siteName: 'Bracemark',
      type: 'website',
    },
    twitter: {
      title: socialTitle,
      description,
      card: 'summary_large_image',
      site: SOCIAL.handle,
    },
  };
}
