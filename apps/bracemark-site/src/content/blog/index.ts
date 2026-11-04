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
  {
    slug: 'saving-from-the-share-sheet',
    title: 'Saving a link without leaving what you’re reading',
    description:
      'How we built the iOS and Android share sheet: a smaller startup path, shared sign-in, searchable lists and tags, and room for the keyboard.',
    publishedAt: '2026-10-28T00:00:00Z',
  },
  {
    slug: 'if-our-servers-go-away',
    title: 'What happens to your links if our servers go away',
    description:
      'In the web and mobile apps, a signed-in device can still open, search, edit, and export the links it has synced if our servers stop. Here’s where that ends.',
    publishedAt: '2026-11-03T00:00:00Z',
  },
  {
    slug: 'connection-allowlists',
    title: 'Why we aren’t using Chrome’s Connection Allowlists',
    description:
      'Chrome’s new header lets the browser refuse a page’s off-list connections. We tested it, and it also blocks a click on a saved link.',
    publishedAt: '2026-11-05T00:00:00Z',
  },
  {
    slug: 'password-managers',
    title: 'Getting your password manager to save the right password',
    description:
      'We can’t reset your password, so the copy your password manager keeps has to be right. We measured what Chrome, Safari, iOS, and Android do with our forms.',
    publishedAt: '2026-11-06T00:00:00Z',
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
