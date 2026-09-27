'use client';

import { useEffect, useRef, useState } from 'react';

import {
  BOOKMARK_CONVERTER_MAX_MB,
  BOOKMARK_CONVERTER_MAX_ROWS,
  BOOKMARK_OUTPUTS,
  type BookmarkConversion,
  type BookmarkOutputFormat,
  bookmarkReceiptText,
} from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import type { ConversionMessage, ConversionRequest } from './bookmark-converter.worker';

const SAMPLE =
  'url,folder,title,note,tags,created\nhttps://example.com/garden,Reading,Garden notes,Plant in spring,garden,2024-04-01T00:00:00.000Z\nhttps://example.com/recipe,Reading/Recipes,Weekend recipe,Try with lemons,food,2024-05-01T00:00:00.000Z\nhttps://example.com/garden,Projects,Garden notes,,garden,\n';

function convertInWorker(
  file: File,
  output: BookmarkOutputFormat,
  signal: AbortSignal,
): Promise<BookmarkConversion> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bookmark-converter.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      worker.terminate();
    };
    const cancel = () => {
      finish();
      reject(new Error('Conversion canceled.'));
    };
    const timeout = window.setTimeout(() => {
      finish();
      reject(new Error('This file took too long to check. Split the export and try again.'));
    }, 60_000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<ConversionMessage>) => {
      finish();
      if (event.data.ok) resolve(event.data.conversion);
      else reject(new Error(event.data.message));
    };
    worker.onerror = worker.onmessageerror = () => {
      finish();
      reject(new Error('Could not check this file. Please try again.'));
    };
    try {
      worker.postMessage({ file, output } satisfies ConversionRequest);
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
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function BookmarkConverter({ appImportUrl }: { appImportUrl: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [output, setOutput] = useState<BookmarkOutputFormat>('html');
  const [conversion, setConversion] = useState<BookmarkConversion | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => active.current?.abort(), []);

  async function convert(nextFile: File, nextOutput: BookmarkOutputFormat) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setFile(nextFile);
    setConversion(null);
    setError('');
    setBusy(true);
    try {
      const result = await convertInWorker(nextFile, nextOutput, controller.signal);
      if (!controller.signal.aborted) setConversion(result);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : 'Could not read this file. Please try again.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function clear() {
    active.current?.abort();
    setFile(null);
    setConversion(null);
    setError('');
    setBusy(false);
    if (input.current) input.current.value = '';
  }

  const receipt = conversion?.receipt;
  const target = BOOKMARK_OUTPUTS.find((item) => item.id === output) ?? BOOKMARK_OUTPUTS[0];
  return (
    <section
      aria-labelledby="converter-heading"
      className={cn('overflow-hidden rounded-xl border border-border bg-background shadow-sm')}
    >
      <div className={cn('border-b border-border px-5 py-5 sm:px-7')}>
        <p className={cn('eyebrow')}>Local file → portable bookmarks</p>
        <h2
          id="converter-heading"
          className={cn('mt-2 font-display text-2xl font-semibold tracking-tight')}
        >
          Choose your file and output
        </h2>
        <p className={cn('mt-2 text-body text-muted-foreground')}>
          No account needed. Your file stays in this browser, and we don’t open the saved pages.
        </p>
        <div className={cn('mt-6 grid gap-6 md:grid-cols-2')}>
          <div
            className={cn('min-w-0 rounded-lg border border-dashed border-border bg-muted/30 p-4')}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer.files.length !== 1) {
                setError('Choose one export file at a time.');
                return;
              }
              void convert(event.dataTransfer.files[0], output);
            }}
          >
            <label htmlFor="bookmark-file" className={cn('block text-sm font-semibold')}>
              1. Open a bookmark export
            </label>
            <p className={cn('mt-2 text-sm leading-6 text-muted-foreground')}>
              Drop a file here, or choose one below. The format is detected from its contents.
            </p>
            <input
              ref={input}
              id="bookmark-file"
              type="file"
              accept=".html,.htm,.csv,.txt,.json,.zip,text/html,text/csv,text/plain,application/json,application/zip"
              aria-describedby="file-help"
              onChange={(event) => {
                const next = event.currentTarget.files?.[0];
                if (next) void convert(next, output);
              }}
              className={cn(
                'mt-3 block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-sm file:mr-3 file:rounded-sm file:border-0 file:bg-muted file:px-3 file:py-2 file:font-medium focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            />
            {file && (
              <p className={cn('mt-3 text-sm font-medium break-all')}>Selected: {file.name}</p>
            )}
            <p id="file-help" className={cn('mt-3 text-xs leading-5 text-muted-foreground')}>
              HTML, CSV, TXT, JSON, or ZIP. Up to {BOOKMARK_CONVERTER_MAX_MB} MB expanded and{' '}
              {BOOKMARK_CONVERTER_MAX_ROWS.toLocaleString()} bookmark records.
            </p>
          </div>
          <fieldset className={cn('min-w-0')}>
            <legend className={cn('text-sm font-semibold')}>2. Choose a download format</legend>
            <div className={cn('mt-3 space-y-2')}>
              {BOOKMARK_OUTPUTS.map((item) => (
                <label
                  key={item.id}
                  className={cn(
                    'flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 has-checked:border-signal has-checked:bg-signal/5',
                  )}
                >
                  <input
                    type="radio"
                    name="output"
                    value={item.id}
                    checked={output === item.id}
                    onChange={() => {
                      setOutput(item.id);
                      if (file) void convert(file, item.id);
                    }}
                    className={cn(
                      'mt-1 size-4 shrink-0 accent-signal focus-visible:ring-3 focus-visible:ring-ring/50',
                    )}
                  />
                  <span>
                    <span className={cn('block text-sm font-medium')}>{item.label}</span>
                    <span className={cn('mt-1 block text-xs leading-5 text-muted-foreground')}>
                      {item.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <div className={cn('mt-4 flex flex-wrap items-center gap-x-5 gap-y-3')}>
          <button
            type="button"
            onClick={() =>
              void convert(new File([SAMPLE], 'sample-bookmarks.csv', { type: 'text/csv' }), output)
            }
            className={cn(
              'rounded-sm text-sm text-signal underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
          >
            Try a sample file
          </button>
          {file && (
            <button
              type="button"
              onClick={clear}
              className={cn(
                'rounded-sm text-sm underline underline-offset-4 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
              )}
            >
              {busy ? 'Cancel and clear file' : 'Clear file'}
            </button>
          )}
        </div>
        {busy && (
          <p role="status" className={cn('mt-4 text-sm break-all')}>
            Checking {file?.name} and preparing {target.label}…
          </p>
        )}
        {error && (
          <p role="alert" className={cn('mt-4 text-sm text-destructive')}>
            {error}
          </p>
        )}
      </div>
      {!file && (
        <p className={cn('px-5 py-6 text-sm leading-6 text-muted-foreground sm:px-7')}>
          Open a file to see its bookmarks, folders, skipped records, and format changes before
          downloading.
        </p>
      )}
      {receipt && conversion && (
        <div className={cn('px-5 py-6 sm:px-7')}>
          <p role="status" className={cn('sr-only')}>
            Ready: {receipt.linkCount} web links in {receipt.outputLabel}. Review changes and
            skipped records before downloading.
          </p>
          <p className={cn('eyebrow')}>Your conversion receipt</p>
          <h3 className={cn('mt-2 font-display text-xl font-semibold tracking-tight')}>
            {receipt.sourceLabel} → {receipt.outputLabel}
          </h3>
          <p
            className={cn('mt-2 truncate font-mono text-xs text-muted-foreground')}
            title={file?.name}
          >
            {file?.name}
          </p>
          <dl
            className={cn(
              'mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4',
            )}
          >
            {[
              ['Source records', receipt.sourceRowCount],
              ['Web links', receipt.linkCount],
              ['Skipped records', receipt.excludedRows.length],
              ['Possible repeats', receipt.duplicateCount],
            ].map(([label, value]) => (
              <div key={label} className={cn('flex flex-col bg-background px-4 py-4')}>
                <dt className={cn('order-2 mt-1 text-xs text-muted-foreground')}>{label}</dt>
                <dd className={cn('font-mono text-2xl font-medium tabular-nums')}>
                  {value.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          <p className={cn('mt-3 text-sm leading-6 text-muted-foreground')}>
            {receipt.uniqueUrlCount.toLocaleString()} unique canonical addresses ·{' '}
            {receipt.folderCount.toLocaleString()} distinct folder paths (
            {receipt.emptyFolderCount.toLocaleString()} empty). Possible repeats can differ by
            scheme or fragment; every web link stays in the download.
          </p>
          <div className={cn('mt-7 grid gap-6 md:grid-cols-2')}>
            <div className={cn('min-w-0')}>
              <h4 className={cn('text-sm font-semibold')}>A few bookmarks in your file</h4>
              <ul
                className={cn(
                  'mt-3 min-w-0 divide-y divide-border overflow-hidden rounded-lg border border-border',
                )}
              >
                {receipt.examples.map((item, index) => (
                  <li key={index} className={cn('min-w-0 px-4 py-3 text-sm')}>
                    <bdi className={cn('block truncate font-medium')} title={item.title}>
                      {item.title}
                    </bdi>
                    <bdi
                      className={cn('mt-1 block truncate font-mono text-xs text-muted-foreground')}
                      title={item.url}
                    >
                      {item.url}
                    </bdi>
                    <bdi
                      className={cn('mt-1 block truncate text-xs text-muted-foreground')}
                      title={item.folder}
                    >
                      {item.folder}
                    </bdi>
                  </li>
                ))}
              </ul>
              {receipt.excludedRows.length > 0 && (
                <details className={cn('mt-5 rounded-lg border border-border p-4')}>
                  <summary
                    className={cn(
                      'cursor-pointer text-sm font-semibold focus-visible:ring-3 focus-visible:ring-ring/50',
                    )}
                  >
                    Review {receipt.excludedRows.length} skipped records
                  </summary>
                  <ul
                    className={cn(
                      'mt-3 max-h-64 space-y-2 overflow-y-auto text-xs leading-5 text-muted-foreground',
                    )}
                  >
                    {receipt.excludedRows.slice(0, 100).map((item, index) => (
                      <li key={index} className={cn('break-words')}>
                        {item.file}, record {item.row}: {item.reason}
                      </li>
                    ))}
                  </ul>
                  {receipt.excludedRows.length > 100 && (
                    <p className={cn('mt-3 text-xs text-muted-foreground')}>
                      Showing the first 100. The downloaded receipt contains every skipped record.
                    </p>
                  )}
                </details>
              )}
            </div>
            <div className={cn('min-w-0')}>
              <h4 className={cn('text-sm font-semibold')}>
                Changes and losses in {receipt.outputLabel}
              </h4>
              <ul
                className={cn(
                  'mt-3 list-disc space-y-2 pl-5 text-sm leading-6 break-words text-muted-foreground',
                )}
              >
                {(receipt.losses.length
                  ? receipt.losses
                  : ['No changes to the parsed bookmark fields. Check the format caveats below.']
                ).map((loss) => (
                  <li key={loss}>{loss}</li>
                ))}
              </ul>
              <details className={cn('mt-5')} open>
                <summary
                  className={cn(
                    'cursor-pointer text-sm font-semibold focus-visible:ring-3 focus-visible:ring-ring/50',
                  )}
                >
                  Format caveats
                </summary>
                <ul
                  className={cn(
                    'mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground',
                  )}
                >
                  {receipt.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            </div>
          </div>
          <div className={cn('mt-7 border-t border-border pt-6')}>
            <h4 className={cn('font-display text-xl font-semibold tracking-tight')}>
              3. Download your bookmarks
            </h4>
            <p className={cn('mt-2 text-sm leading-6 text-muted-foreground')}>
              The generated file was read back to check its addresses and compare its fields. Your
              original file is unchanged.
            </p>
            <div className={cn('mt-4 flex flex-wrap gap-3')}>
              <button
                type="button"
                onClick={() =>
                  download(
                    `${(file?.name ?? 'bookmarks').replace(/\.[^.]+$/, '')}-converted.${conversion.extension}`,
                    conversion.content,
                    conversion.mime,
                  )
                }
                className={cn(
                  'rounded-md bg-signal px-4 py-2.5 text-sm font-medium text-white hover:bg-signal-strong focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:outline-none',
                )}
              >
                Download {receipt.outputLabel}
              </button>
              <button
                type="button"
                onClick={() =>
                  download(
                    'conversion-receipt.txt',
                    bookmarkReceiptText(conversion),
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
                href={appImportUrl}
                className={cn(
                  'text-signal underline underline-offset-2 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                )}
              >
                import the original file
              </a>{' '}
              in Settings → Data. Choose it again there; this tool hasn’t imported it.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
