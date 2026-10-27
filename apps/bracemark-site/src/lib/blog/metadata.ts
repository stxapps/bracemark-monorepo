import type { Metadata, ResolvingMetadata } from 'next';

import type { BlogPost } from '../../content/blog';
import { pageMetadata } from '../metadata';

/** A post's canonical and card: an `article`, with its author-set times. */
export function blogPostMetadata(parent: ResolvingMetadata, post: BlogPost): Promise<Metadata> {
  return pageMetadata(parent, {
    title: post.title,
    description: post.description,
    path: `/blog/${post.slug}`,
    article: { publishedTime: post.publishedAt, modifiedTime: post.updatedAt },
  });
}

export function blogDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
