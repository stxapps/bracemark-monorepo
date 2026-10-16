import { parseImportText } from '../import/parse';
import { TREE_MAX_DEPTH } from '../sync/tree';
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

  it('writes descriptions only when requested for a standalone file conversion', () => {
    const snapshot = bundle([folder('L', [link({ note: 'First <draft> & second' })])]);
    expect(toNetscapeHtml(snapshot)).not.toContain('<DD>');
    const html = toNetscapeHtml(snapshot, { includeNotes: true });
    expect(html).toContain('<DD>First &lt;draft&gt; &amp; second');
    expect(parseImportText(html).links[0].note).toBe('First <draft> & second');
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

  it('opens and closes one DL per folder, at the folder’s own indent', () => {
    // The nesting test above pins where the H3s land; this pins the CLOSES. An
    // unbalanced or mis-indented `</DL><p>` leaves the tree malformed, and a
    // line-wise importer (which is what real ones are) then reparents every
    // link after it — a restore whose folders are silently wrong, not missing.
    const html = toNetscapeHtml(
      bundle([folder('Parent', [link()], [folder('Child', [link()])]), folder('Sibling')]),
    );
    const opens = html.match(/<DL><p>/g) ?? [];
    const closes = html.match(/<\/DL><p>/g) ?? [];

    expect(opens).toHaveLength(closes.length); // root + 3 folders
    expect(opens).toHaveLength(4);
    expect(html).toContain('        </DL><p>'); // Child, one level in from Parent
    expect(html).toContain('    </DL><p>'); // Parent and Sibling
    expect(html.trimEnd().endsWith('\n</DL><p>')).toBe(true); // the root list, last
  });

  it('emits an empty folder as a header and an empty list', () => {
    // bundle.ts calls this out as deliberate: "empty folders DO appear — an
    // importer recreating the user's structure is a feature, not noise." Dropping
    // them would still pass every other assertion in this file.
    const html = toNetscapeHtml(bundle([folder('Empty')]));

    expect(html).toContain('    <DT><H3>Empty</H3>\n    <DL><p>\n    </DL><p>');
  });

  it('truncates sub-second timestamps rather than rounding them', () => {
    // The existing seconds test uses whole-second inputs, so `Math.round` would
    // pass it. Truncation is the right choice — a rounded-up ADD_DATE puts the
    // link a second in the future of when it was saved.
    const html = toNetscapeHtml(
      bundle([folder('L', [link({ createdAt: 1_700_000_000_999, updatedAt: 1_700_000_001_500 })])]),
    );

    expect(html).toContain('ADD_DATE="1700000000"');
    expect(html).toContain('LAST_MODIFIED="1700000001"');
  });
});

// export/netscape.ts and import/netscape.ts are documented as read mirrors of
// each other, and nothing tested the pair: every assertion above is a substring
// of the written file, so a serializer and a parser could drift apart and both
// specs stay green. Going through parseImportText also pins DETECTION — a file
// we write but do not recognise re-imports as the wrong format entirely.
describe('toNetscapeHtml → parseImportText', () => {
  const reimport = (text: string) => parseImportText(text).links;

  it('recovers the folder chain from the nesting, detection included', () => {
    const html = toNetscapeHtml(
      bundle([
        folder(
          'Parent',
          [link({ url: 'https://example.com/top' })],
          [folder('Child', [link({ url: 'https://example.com/deep' })])],
        ),
      ]),
    );

    // The serializer's root <DL> is an anonymous scope on the way back in, so it
    // contributes nothing to the path — the chain is the user's own folders.
    expect(reimport(html).map((row) => [row.url, row.folderPath])).toEqual([
      ['https://example.com/top', ['Parent']],
      ['https://example.com/deep', ['Parent', 'Child']],
    ]);
  });

  it('recovers title, tags and both timestamps at second precision', () => {
    const html = toNetscapeHtml(
      bundle([folder('L', [link({ title: 'A <i>&</i> B', tagNames: ['work', 'read later'] })])]),
    );

    expect(reimport(html)).toEqual([
      {
        url: 'https://example.com/a',
        customTitle: 'A <i>&</i> B',
        tagNames: ['work', 'read later'],
        folderPath: ['L'],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
      },
    ]);
  });

  it('survives a title that looks like markup', () => {
    // The parser is a regex tokenizer over tag soup, so an escaped `</A>` inside
    // a title is the case that could end the anchor early and swallow the rest of
    // the file. It has to come back as text.
    const html = toNetscapeHtml(bundle([folder('L', [link({ title: 'closing </A> tag' })])]));

    expect(reimport(html)).toHaveLength(1);
    expect(reimport(html)[0]?.customTitle).toBe('closing </A> tag');
  });

  it('drops an empty folder, which is the round trip’s one structural loss', () => {
    // The serializer writes the header (see above), but a folder with no links
    // yields no ROWS, and rows are all an importer gets — so the empty list is
    // recreated only by an importer that reads the headers themselves. Ours
    // doesn't, deliberately: it resolves folders from each link's path.
    expect(reimport(toNetscapeHtml(bundle([folder('Empty')])))).toEqual([]);
  });
});

// Every line is indented by its folder's depth, so an unbounded chain made the
// file grow with the square of it: 10,000 nested lists ended the export in
// `RangeError: Invalid string length`, nothing saved.
describe('toNetscapeHtml past TREE_MAX_DEPTH', () => {
  // A chain of `depth` folders named f0, f1, … each holding one link.
  function chain(depth: number): ExportFolder[] {
    let below: ExportFolder[] = [];
    for (let i = depth - 1; i >= 0; i--) {
      below = [folder(`f${i}`, [link({ url: `https://example.com/f${i}` })], below)];
    }
    return below;
  }
  const names = (count: number) => Array.from({ length: count }, (_, i) => `f${i}`);

  it('closes the folder at the depth before its children, which follow at its level', () => {
    const depth = TREE_MAX_DEPTH + 2;
    const html = toNetscapeHtml(bundle(chain(depth)));
    const indent = (name: string) => html.match(new RegExp(`^( *)<DT><H3>${name}</H3>`, 'm'))?.[1];

    expect(indent(`f${depth - 1}`)).toBe(indent(`f${TREE_MAX_DEPTH - 1}`));
    expect(indent(`f${depth - 1}`)).toHaveLength(4 * TREE_MAX_DEPTH);
    // Balanced, or a line-wise importer reparents everything after the cut.
    expect(html.match(/<\/DL><p>/g)).toHaveLength(depth + 1);
    expect(html.match(/<DL><p>/g)).toHaveLength(depth + 1);
  });

  it('writes 10,000 nested lists into a file this app’s import nests as written', () => {
    const depth = 10_000;
    const rows = parseImportText(toNetscapeHtml(bundle(chain(depth)))).links;

    expect(rows).toHaveLength(depth);
    // No folder past the depth, so an import places none of them elsewhere.
    expect(rows.every((row) => row.folderPath.length <= TREE_MAX_DEPTH)).toBe(true);
    // The same paths the CSV writes (csv.spec.ts): a list past the depth keeps
    // its own name, under the ancestors the depth allows.
    expect(rows[TREE_MAX_DEPTH - 1]?.folderPath).toEqual(names(TREE_MAX_DEPTH));
    expect(rows.at(-1)?.folderPath).toEqual([...names(TREE_MAX_DEPTH - 1), `f${depth - 1}`]);
  });
});
