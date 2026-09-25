// The published blog manifest. Its fields are shared by the index, article
// pages, metadata, sitemap, and RSS feed. Keep draft prose outside this folder:
// blog.spec.ts checks that every MDX file here has a published manifest entry.

export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt?: string;
};

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'introducing-bracemark',
    title: 'Introducing Bracemark',
    description:
      'Bracemark is here: save links across devices, keep the readable copy on your own devices, and take your data with you.',
    // TODO(launch): Replace this provisional timestamp with the actual publication date and time.
    publishedAt: '2026-09-25T00:00:00Z',
  },
];

export function findBlogPost(slug: string): BlogPost | undefined {
  return BLOG_POSTS.find((post) => post.slug === slug);
}

export function publishedBlogPosts(): BlogPost[] {
  return [...BLOG_POSTS].sort(
    (left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
  );
}
