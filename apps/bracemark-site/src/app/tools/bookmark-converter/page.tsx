import type { Metadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../../components/page-shell';
import { APP_URL, SITE_URL } from '../../../lib/site';
import { BookmarkConverter } from './bookmark-converter';

export const metadata: Metadata = {
  title: 'Bookmark converter — HTML, CSV, JSON, ZIP, and text',
  description:
    'Convert bookmark exports to browser HTML, CSV, or URL text in your browser. Read exports from Raindrop.io, Pocket, LinkWarden, Brace.to, and Bracemark backups. No upload or account needed.',
  alternates: { canonical: `${SITE_URL}/tools/bookmark-converter` },
};

const INPUTS = [
  ['Bookmarks HTML', 'Browser exports, Raindrop.io, Karakeep, and other Netscape bookmark files.'],
  [
    'CSV',
    'Raindrop.io, Pocket, Bracemark, or a CSV with a url column. Recognized fields: folder, title, note, tags, created, time_added, status, highlights, and favorite.',
  ],
  [
    'JSON / Brace.to TXT',
    'LinkWarden JSON and Brace.to exports. Other JSON layouts are not supported.',
  ],
  [
    'URL text',
    'One HTTP(S) address per line. Addresses beginning with www. are given an https:// prefix.',
  ],
  ['ZIP', 'Pocket CSV parts and archives of the supported files above.'],
  [
    'Bracemark backup',
    'The ZIP from Settings → Data. The converter reads its links, lists, and tags and never opens the images, so the ZIP itself has no size limit.',
  ],
];

export default function Page() {
  return (
    <PageShell
      eyebrow="Free tool"
      title="Your bookmarks. A different format."
      lede="Convert a bookmark export to HTML, CSV, or plain text. See what carries over, what changes, and what gets left out before you download."
    >
      <BookmarkConverter appImportUrl={`${APP_URL}/settings/data`} />
      <section
        className={cn('mt-12 border-t border-border pt-10')}
        aria-labelledby="formats-heading"
      >
        <h2
          id="formats-heading"
          className={cn('font-display text-2xl font-semibold tracking-tight')}
        >
          Which files can I convert?
        </h2>
        <p className={cn('mt-3 text-body text-muted-foreground')}>
          Every supported input can be converted to any of the three output formats. JSON and ZIP
          are input formats only.
        </p>
        <dl className={cn('mt-5 divide-y divide-border border-y border-border')}>
          {INPUTS.map(([format, description]) => (
            <div key={format} className={cn('grid gap-2 py-4 sm:grid-cols-[10rem_1fr] sm:gap-6')}>
              <dt className={cn('text-sm font-semibold')}>{format}</dt>
              <dd className={cn('text-sm leading-6 text-muted-foreground')}>{description}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={cn('mt-10')} aria-labelledby="fields-heading">
        <h2
          id="fields-heading"
          className={cn('font-display text-2xl font-semibold tracking-tight')}
        >
          What survives the conversion?
        </h2>
        <div className={cn('mt-5 overflow-x-auto rounded-lg border border-border')}>
          <table className={cn('w-full text-left text-sm')}>
            <caption className={cn('sr-only')}>Fields carried by each output format</caption>
            <thead className={cn('bg-muted/40')}>
              <tr>
                {['Field', 'HTML', 'CSV', 'URL text'].map((name) => (
                  <th key={name} scope="col" className={cn('px-4 py-3 font-semibold')}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cn('divide-y divide-border')}>
              {[
                ['Web addresses', 'Yes', 'Yes', 'Yes'],
                ['Titles', 'Yes', 'Yes', 'No'],
                ['Folders', 'Nested folders', 'Slash-separated paths', 'No'],
                ['Empty folders', 'Yes, when identified', 'No', 'No'],
                ['Notes and tags', 'Written; apps may ignore them', 'Columns', 'No'],
                ['Saved dates', 'Whole seconds', 'ISO dates', 'No'],
                ['Updated dates', 'Whole seconds', 'No', 'No'],
                ['Images and archived pages', 'No', 'No', 'No'],
              ].map(([field, ...values]) => (
                <tr key={field}>
                  <th scope="row" className={cn('px-4 py-3 font-medium')}>
                    {field}
                  </th>
                  {values.map((value, index) => (
                    <td key={index} className={cn('px-4 py-3 text-muted-foreground')}>
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={cn('mt-3 text-body text-muted-foreground')}>
          For example, a bookmark titled “Garden notes” in Reading keeps its title and folder in
          HTML. CSV writes Reading in a folder column. URL text keeps only its address. The sample
          file lets you compare all three.
        </p>
      </section>
      <div className={cn('mt-10 grid gap-10 border-t border-border pt-10 sm:grid-cols-2')}>
        <section>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            Does my file leave this device?
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            Your browser reads the selected file and creates the download. This tool doesn’t upload
            its contents, save them in browser storage, or request any saved address. The page still
            loads its normal site assets. Clear the file or close the tab when you’re finished.
          </p>
        </section>
        <section>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            Are duplicates removed?
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            No. Repeated addresses can belong in different folders, and URL variants can mean
            different pages. The receipt counts possible repeats and keeps them all. Older revisions
            in a Brace.to export are reported separately as skipped records.
          </p>
        </section>
        <section>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            Will it recreate my whole backup?
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            These downloads carry bookmarks. They don’t recreate account settings, images, archived
            pages, or pin order. Links in Trash are left out, because another app would import them
            as live bookmarks, and the receipt counts them. Archive becomes an ordinary folder, so
            another app may import the links in it as active bookmarks. CSV cells that could be
            formulas receive a leading apostrophe for spreadsheet protection.
          </p>
        </section>
        <section>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            Moving to Bracemark?
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            You can import supported original files directly. Read the{' '}
            <Link
              href="/docs/import"
              className={cn(
                'text-signal underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            >
              import guide
            </Link>{' '}
            or the{' '}
            <Link
              href="/docs/import-from-raindrop"
              className={cn(
                'text-signal underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            >
              Raindrop.io guide
            </Link>{' '}
            before choosing a file in Settings → Data.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
