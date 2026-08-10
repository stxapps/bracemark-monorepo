import type { ExportBundle, ExportFolder, ExportLinkRow } from './bundle';
import { toRaindropCsv } from './csv';

function link(over: Partial<ExportLinkRow> = {}): ExportLinkRow {
  return {
    url: 'https://example.com/a',
    title: 'Example',
    tagNames: [],
    createdAt: Date.UTC(2026, 0, 2, 3, 4, 5),
    updatedAt: Date.UTC(2026, 0, 2, 3, 4, 6),
    ...over,
  };
}

function folder(
  name: string,
  links: ExportLinkRow[] = [],
  children: ExportFolder[] = [],
): ExportFolder {
  return { name, links, children };
}

function bundle(folders: ExportFolder[]): ExportBundle {
  return { folders, exportedAt: 0 };
}

describe('toRaindropCsv', () => {
  it('emits only the header for an empty bundle, CRLF-terminated', () => {
    expect(toRaindropCsv(bundle([]))).toBe('url,folder,title,note,tags,created\r\n');
  });

  it('writes one row per link with the slash-joined folder path and ISO created', () => {
    const csv = toRaindropCsv(bundle([folder('Parent', [], [folder('Child', [link()])])]));
    const rows = csv.trimEnd().split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe('https://example.com/a,Parent/Child,Example,,,2026-01-02T03:04:05.000Z');
  });

  it('joins tag names with commas inside one quoted cell', () => {
    const csv = toRaindropCsv(bundle([folder('L', [link({ tagNames: ['a', 'b'] })])]));
    expect(csv).toContain(',"a,b",');
  });

  it('quotes fields containing commas, quotes, or newlines and doubles inner quotes', () => {
    const csv = toRaindropCsv(
      bundle([folder('A,B', [link({ title: 'say "hi"', note: 'line1\nline2' })])]),
    );
    expect(csv).toContain('"A,B"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"line1\nline2"');
  });
});
