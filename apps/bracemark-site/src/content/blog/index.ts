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
      'Bracemark’s first release lets you save links across devices. We explain how encrypted sync works and what it costs.',
    publishedAt: '2026-10-13T00:00:00Z',
  },
  {
    slug: 'source-security-review-2026-10',
    title: 'Source security review, October 2026',
    description:
      'Our AI-assisted source review recorded low-severity findings and open questions. We explain the method, what launch changed, and what still needs evidence.',
    publishedAt: '2026-10-26T00:00:00Z',
  },
  {
    slug: 'importing-your-links',
    title: 'Bringing your links to Bracemark',
    description:
      'How we handle bookmark formats, test real exports, and measure long imports so you can try Bracemark with the links you already have.',
    publishedAt: '2026-10-27T00:00:00Z',
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
