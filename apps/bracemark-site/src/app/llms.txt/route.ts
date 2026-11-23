import { llmsTxt } from '../../lib/llms-txt';

// Next exports this GET response as out/llms.txt. As with feed.xml, S3 keeps none
// of these headers: deploy-static.sh re-uploads the object with the same
// Content-Type, charset included, because the file carries curly quotes and
// `aws s3 sync` would publish it as bare `text/plain`.
export const dynamic = 'force-static';

export function GET(): Response {
  return new Response(llmsTxt(), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
