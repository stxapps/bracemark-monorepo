import { blogFeed } from './feed';

describe('/feed.xml', () => {
  it('escapes content and keeps the original publication date and permalink', () => {
    const body = blogFeed([
      {
        slug: 'a-post',
        title: 'A & <B>',
        description: 'A "quoted" summary & more',
        publishedAt: '2026-09-25T12:30:00Z',
        updatedAt: '2026-09-26T12:30:00Z',
      },
    ]);

    expect(body).toContain('<title>A &amp; &lt;B&gt;</title>');
    expect(body).toContain('<description>A &quot;quoted&quot; summary &amp; more</description>');
    expect(body).toContain('<guid isPermaLink="true">https://bracemark.com/blog/a-post</guid>');
    expect(body).toContain('<pubDate>Fri, 25 Sep 2026 12:30:00 GMT</pubDate>');
    expect(body).not.toContain('Sat, 26 Sep 2026');
  });
});
