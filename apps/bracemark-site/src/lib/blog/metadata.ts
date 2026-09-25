import type { Metadata } from 'next';

import { SOCIAL } from '@stxapps/shared';

import type { BlogPost } from '../../content/blog';
import { SITE_URL } from '../site';

export function blogPostMetadata(post: BlogPost): Metadata {
  const url = `${SITE_URL}/blog/${post.slug}`;
  const title = `${post.title} · Bracemark`;

  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'article',
      title,
      description: post.description,
      url,
      siteName: 'Bracemark',
      publishedTime: post.publishedAt,
      ...(post.updatedAt && { modifiedTime: post.updatedAt }),
    },
    twitter: {
      title,
      description: post.description,
      card: 'summary_large_image',
      site: SOCIAL.handle,
    },
  };
}

export function blogDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
