import { blogFeed } from '../../lib/blog/feed';

// Next exports this GET response as out/feed.xml. deploy-static.sh sets the
// same RSS content type on the S3 object; S3 does not keep this response header.
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(blogFeed(), {
    headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
  });
}
