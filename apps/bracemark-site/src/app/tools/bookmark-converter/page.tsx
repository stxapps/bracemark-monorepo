import type { Metadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../../components/page-shell';
import { APP_URL, SITE_URL } from '../../../lib/site';
import { BookmarkConverter } from './bookmark-converter';

export const metadata: Metadata = {
  title: 'Bookmark file checker and converter',
  description:
    'Check a Raindrop.io CSV export in your browser, see what a conversion would lose, and download browser bookmarks HTML without an account.',
  alternates: { canonical: `${SITE_URL}/tools/bookmark-converter` },
};

export default function Page() {
  return (
    <PageShell
      eyebrow="Free tool"
      title="Check a bookmark file. Convert it when you need to."
      lede="Choose a Raindrop.io CSV export to see its links, skipped rows, and what a browser bookmarks HTML file can carry."
    >
      <BookmarkConverter appImportUrl={`${APP_URL}/settings/data`} />

      <div className={cn('mt-12 grid gap-10 border-t border-border pt-10 sm:grid-cols-2')}>
        <section>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            What this accepts
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            This first version reads a Raindrop.io CSV export and makes browser bookmarks HTML. It
            keeps web addresses, titles, and folder paths. It writes notes, tags, and saved dates
            where the HTML format allows them, though your destination may ignore those fields.
          </p>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            Raindrop.io also exports HTML directly. Use that original HTML file when you need its
            exact folder nesting or want to import into Bracemark. See the{' '}
            <Link
              href="/docs/import-from-raindrop"
              className={cn(
                'text-signal underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            >
              Raindrop.io import guide
            </Link>
            .
          </p>
        </section>
        <section>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            How the file is handled
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            Your browser reads the selected file and creates the download. This tool doesn’t upload
            its contents or request any saved address. The page still loads its normal site assets.
          </p>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            The receipt names excluded rows and populated fields that the HTML file can’t carry. We
            leave repeats in place and keep the original file untouched.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
