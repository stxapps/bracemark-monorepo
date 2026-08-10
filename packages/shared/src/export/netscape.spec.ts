import type { ExportBundle, ExportFolder, ExportLinkRow } from './bundle';
import { toNetscapeHtml } from './netscape';

function link(over: Partial<ExportLinkRow> = {}): ExportLinkRow {
  return {
    url: 'https://example.com/a',
    title: 'Example',
    tagNames: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
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
  return { folders, exportedAt: 1_700_000_002_000 };
}

describe('toNetscapeHtml', () => {
  it('emits the Netscape header and root list even when empty', () => {
    const html = toNetscapeHtml(bundle([]));
    expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n')).toBe(true);
    expect(html).toContain('<H1>Bookmarks</H1>');
    expect(html).toContain('<DL><p>\n</DL><p>');
    expect(html.endsWith('\n')).toBe(true);
  });

  it('nests child folders inside their parent and links inside folders', () => {
    const html = toNetscapeHtml(
      bundle([
        folder('Parent', [link()], [folder('Child', [link({ url: 'https://example.com/b' })])]),
      ]),
    );
    const parent = html.indexOf('<H3>Parent</H3>');
    const a = html.indexOf('https://example.com/a');
    const child = html.indexOf('<H3>Child</H3>');
    const b = html.indexOf('https://example.com/b');
    expect(parent).toBeGreaterThan(-1);
    // Document order: parent folder, its link, then the child folder and its link.
    expect(a).toBeGreaterThan(parent);
    expect(child).toBeGreaterThan(a);
    expect(b).toBeGreaterThan(child);
    // Child rows indent one level (4 spaces) past the parent's.
    expect(html).toContain('    <DT><H3>Parent</H3>');
    expect(html).toContain('        <DT><H3>Child</H3>');
  });

  it('converts timestamps to epoch seconds', () => {
    const html = toNetscapeHtml(bundle([folder('L', [link()])]));
    expect(html).toContain('ADD_DATE="1700000000"');
    expect(html).toContain('LAST_MODIFIED="1700000001"');
  });

  it('writes tag names into TAGS and omits the attribute when tagless', () => {
    const tagged = toNetscapeHtml(
      bundle([folder('L', [link({ tagNames: ['work', 'read later'] })])]),
    );
    expect(tagged).toContain('TAGS="work,read later"');
    const untagged = toNetscapeHtml(bundle([folder('L', [link()])]));
    expect(untagged).not.toContain('TAGS=');
  });

  it('escapes HTML in titles, folder names, urls, and tags', () => {
    const html = toNetscapeHtml(
      bundle([
        folder('<b>&"Lists"', [
          link({ url: 'https://example.com/?a=1&b="2"', title: 'A <i>&</i> B', tagNames: ['<t>'] }),
        ]),
      ]),
    );
    expect(html).toContain('<H3>&lt;b&gt;&amp;&quot;Lists&quot;</H3>');
    expect(html).toContain('HREF="https://example.com/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('>A &lt;i&gt;&amp;&lt;/i&gt; B</A>');
    expect(html).toContain('TAGS="&lt;t&gt;"');
  });
});
