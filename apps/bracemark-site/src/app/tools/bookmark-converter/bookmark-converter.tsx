'use client';

import { useState } from 'react';

import {
  BOOKMARK_CONVERTER_MAX_BYTES,
  BOOKMARK_CONVERTER_MAX_MB,
  BOOKMARK_CONVERTER_MAX_ROWS,
  type BookmarkConversion,
} from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import type { ConversionMessage } from './bookmark-converter.worker';

interface BookmarkConverterProps {
  appImportUrl: string;
}

function convertInWorker(file: File): Promise<BookmarkConversion> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bookmark-converter.worker.ts', import.meta.url), {
      type: 'module',
    });
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error('This file took too long to check. Split the export and try again.'));
    }, 60_000);
    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<ConversionMessage>) => {
      finish();
      if (event.data.ok) resolve(event.data.conversion);
      else reject(new Error(event.data.message));
    };
    worker.onerror = () => {
      finish();
      reject(new Error('Could not check this file. Please try again.'));
    };
    worker.onmessageerror = () => {
      finish();
      reject(new Error('Could not read the conversion result. Please try again.'));
    };
    try {
      worker.postMessage(file);
    } catch {
      finish();
      reject(new Error('Could not read this file. Please try again.'));
    }
  });
}

function download(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function receiptText(conversion: BookmarkConversion): string {
  const { receipt } = conversion;
  return [
    'Bookmark conversion receipt',
    'Raindrop.io CSV → browser bookmarks HTML',
    '',
    `Source rows: ${receipt.sourceRows}`,
    `Web links exported: ${receipt.webLinks}`,
    `Rows skipped: ${receipt.skippedRows}`,
    `Possible duplicate addresses: ${receipt.possibleDuplicates} (kept)`,
    `Folders represented: ${receipt.folders}`,
    '',
    'Excluded rows',
    ...(receipt.excludedRows.length
      ? receipt.excludedRows.map((item) => `Row ${item.row}: ${item.reason}`)
      : ['None.']),
    '',
    'Known losses',
    ...(receipt.losses.length
      ? receipt.losses
      : ['No populated source fields were removed by this conversion.']),
    '',
    'Warnings',
    ...receipt.warnings,
    '',
    'The original file was not changed. This receipt does not mean a file was imported into Bracemark.',
  ].join('\n');
}

export function BookmarkConverter({ appImportUrl }: BookmarkConverterProps) {
  const [fileName, setFileName] = useState('');
  const [conversion, setConversion] = useState<BookmarkConversion | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function chooseFile(file: File | undefined) {
    setConversion(null);
    setError('');
    setFileName(file?.name ?? '');
    if (!file) return;
    if (file.size > BOOKMARK_CONVERTER_MAX_BYTES) {
      setError(
        `This file is too large. Choose a CSV export up to ${BOOKMARK_CONVERTER_MAX_MB} MB.`,
      );
      return;
    }
    setBusy(true);
    try {
      setConversion(await convertInWorker(file));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not read this file. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const receipt = conversion?.receipt;
  return (
    <section
      aria-labelledby="converter-heading"
      className={cn('rounded-xl border border-border bg-background shadow-sm')}
    >
      <div className={cn('border-b border-border px-5 py-5 sm:px-7')}>
        <p className={cn('eyebrow')}>Your file</p>
        <h2
          id="converter-heading"
          className={cn('mt-2 font-display text-2xl font-semibold tracking-tight')}
        >
          Choose a Raindrop.io CSV export
        </h2>
        <p className={cn('mt-2 text-body text-muted-foreground')}>
          We read this file in your browser. It isn’t uploaded, and we don’t open the saved pages.
        </p>
        <div className={cn('mt-5')}>
          <label htmlFor="bookmark-file" className={cn('block text-sm font-medium')}>
            CSV file
          </label>
          <input
            id="bookmark-file"
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            aria-describedby="file-help"
            onChange={(event) => void chooseFile(event.currentTarget.files?.[0])}
            className={cn(
              'mt-2 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm file:mr-4 file:rounded-sm file:border-0 file:bg-muted file:px-3 file:py-2 file:font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
          />
          <p id="file-help" className={cn('mt-2 text-sm text-muted-foreground')}>
            Up to {BOOKMARK_CONVERTER_MAX_MB} MB and{' '}
            {BOOKMARK_CONVERTER_MAX_ROWS.toLocaleString()} bookmark rows. The CSV must be exported by
            Raindrop.io.
          </p>
        </div>
        {busy && (
          <p role="status" className={cn('mt-4 text-sm')}>
            Checking {fileName}…
          </p>
        )}
        {error && (
          <p role="alert" className={cn('mt-4 text-sm text-destructive')}>
            {error}
          </p>
        )}
      </div>

      {receipt && conversion && (
        <div className={cn('px-5 py-6 sm:px-7')}>
          <p role="status" className={cn('sr-only')}>
            Found {receipt.webLinks} web links. Review skipped rows and field losses before
            downloading.
          </p>
          <div className={cn('flex flex-wrap items-baseline justify-between gap-2')}>
            <h3 className={cn('font-display text-xl font-semibold tracking-tight')}>
              What we found
            </h3>
            <p
              className={cn('max-w-full truncate font-mono text-xs text-muted-foreground')}
              title={fileName}
            >
              {fileName}
            </p>
          </div>
          <div
            className={cn(
              'mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4',
            )}
          >
            {[
              ['Source rows', receipt.sourceRows],
              ['Web links', receipt.webLinks],
              ['Skipped rows', receipt.skippedRows],
              ['Possible repeats', receipt.possibleDuplicates],
            ].map(([label, value]) => (
              <div key={label} className={cn('bg-muted/35 px-4 py-4')}>
                <p className={cn('font-mono text-2xl font-medium tabular-nums')}>{value}</p>
                <p className={cn('mt-1 text-xs text-muted-foreground')}>{label}</p>
              </div>
            ))}
          </div>
          <p className={cn('mt-3 text-sm text-muted-foreground')}>
            {receipt.folders} folders represented. Possible repeats are based on address; every row
            stays in the download.
          </p>

          <div className={cn('mt-7 grid gap-6 md:grid-cols-2')}>
            <div className={cn('min-w-0')}>
              <h4 className={cn('text-sm font-semibold')}>A few links in the file</h4>
              <ul
                className={cn(
                  'mt-3 min-w-0 divide-y divide-border overflow-hidden rounded-lg border border-border',
                )}
              >
                {receipt.examples.map((item, index) => (
                  <li key={`${item.url}-${index}`} className={cn('min-w-0 px-4 py-3 text-sm')}>
                    <bdi className={cn('block truncate font-medium')}>{item.title}</bdi>
                    <bdi
                      className={cn('mt-1 block truncate font-mono text-xs text-muted-foreground')}
                    >
                      {item.url}
                    </bdi>
                    <span className={cn('mt-1 block text-xs text-muted-foreground')}>
                      {item.folder}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className={cn('min-w-0')}>
              <h4 className={cn('text-sm font-semibold')}>What the HTML file won’t carry</h4>
              <ul
                className={cn(
                  'mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground',
                )}
              >
                {(receipt.losses.length
                  ? receipt.losses
                  : ['No populated source fields are removed by this conversion.']
                ).map((loss) => (
                  <li key={loss}>{loss}</li>
                ))}
              </ul>
              <h4 className={cn('mt-5 text-sm font-semibold')}>Check before downloading</h4>
              <ul
                className={cn(
                  'mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground',
                )}
              >
                {receipt.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              {receipt.excludedRows.length > 0 && (
                <p className={cn('mt-3 text-sm text-muted-foreground')}>
                  First skipped rows:{' '}
                  {receipt.excludedRows
                    .slice(0, 5)
                    .map((item) => `${item.row} (${item.reason})`)
                    .join(', ')}
                  {receipt.excludedRows.length > 5
                    ? `, and ${receipt.excludedRows.length - 5} more in the receipt`
                    : ''}
                  .
                </p>
              )}
            </div>
          </div>

          <div className={cn('mt-7 border-t border-border pt-6')}>
            <h4 className={cn('font-display text-xl font-semibold tracking-tight')}>
              Download the converted file
            </h4>
            <p className={cn('mt-2 text-sm leading-6 text-muted-foreground')}>
              The original CSV stays as it is. We checked the HTML output by reading it again before
              making this download available.
            </p>
            <div className={cn('mt-4 flex flex-wrap gap-3')}>
              <button
                type="button"
                onClick={() =>
                  download('raindrop-bookmarks.html', conversion.html, 'text/html;charset=utf-8')
                }
                className={cn(
                  'rounded-md bg-signal px-4 py-2.5 text-sm font-medium text-white hover:bg-signal-strong focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:outline-none',
                )}
              >
                Download bookmarks HTML
              </button>
              <button
                type="button"
                onClick={() =>
                  download(
                    'conversion-receipt.txt',
                    receiptText(conversion),
                    'text/plain;charset=utf-8',
                  )
                }
                className={cn(
                  'rounded-md border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                )}
              >
                Download receipt
              </button>
            </div>
            <p className={cn('mt-5 text-sm leading-6 text-muted-foreground')}>
              Moving to Bracemark? You can{' '}
              <a
                className={cn(
                  'text-signal underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                )}
                href={appImportUrl}
              >
                import the original CSV
              </a>{' '}
              there. Choose it again in Settings → Data; this check hasn’t imported it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
