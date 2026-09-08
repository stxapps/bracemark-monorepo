import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectTextImportFormat } from './detect';
import { parseImportText } from './parse';

// A REAL Brace.to export, trimmed and anonymized, run through the real dispatch.
//
// `brace.spec.ts` beside this file covers the parser's rules one at a time with
// hand-written entries, and that is the right shape for rules. What it cannot
// cover is the thing a hand-written fixture is built from: the assumption about
// what the file looks like. Every fixture there agrees with the parser by
// construction, because the same person wrote both.
//
// So this file is the other half — one whole export, exercised end to end through
// `parseImportText` (detection included, since a misroute is the failure mode
// that hurts here), asserted on RELATIONS rather than on values, so a change to
// the fixture doesn't have to be mirrored in a table of expectations.
//
// __fixtures__/brace-export.json is 15 of the 83 entries of one real account's
// export, chosen for coverage rather than volume: a link in a nested list, a
// pinned one, a tagged one, one moved by an `sslts/` entry, one archived, one
// trashed, and one carrying both a user title and a custom image. Everything
// structural is verbatim — the path grammar, the opaque list/tag id segments,
// the three-level `listNameMap` (whose `Trash` entry has no `children` key at
// all), the settings filename's DOUBLE timestamp (`settings<dt><rnd>_<dt><rnd>`,
// which the hand-written fixtures spell with one), the `{}` payloads that carry
// no data because the PATH is the data, and `cdroot/`-prefixed image keys. URLs,
// page titles and image bytes are replaced; ids, timestamps, decor and the
// display names are not.
const EXPORT = readFileSync(join(__dirname, '__fixtures__', 'brace-export.json'), 'utf8');

// Brace names its export `.txt`, which is the whole reason detection here is
// structural rather than by extension.
const bundle = parseImportText(EXPORT, 'Brace.to data 2026-9-8 09-44-58.txt');

// Every `links/` entry in the file; the parser should yield exactly these and
// nothing else. Derived from the fixture rather than hardcoded, so trimming it
// further doesn't invalidate the assertions.
const raw = JSON.parse(EXPORT) as { path: string; data: Record<string, unknown> }[];
const linkEntries = raw.filter((entry) => entry.path.startsWith('links/'));

describe('a real Brace.to export', () => {
  // THE silent failure this format's parser exists to prevent. The file is a
  // `.txt`, so before the structural probe it sniffed as plain text and the
  // URL-extracting parser mined the raw JSON — every dead revision, every
  // `extractedResult.image`, every favicon — producing a plausible-looking mess
  // instead of an error. Asserted as a SET relation, which is what a misroute
  // breaks: a text-mined run yields far more rows than the file has links, and
  // rows the file never listed as a link.
  it('is routed by structure, not by its .txt extension', () => {
    expect(detectTextImportFormat(EXPORT, 'Brace.to data.txt')).toBe('brace');

    const declared = new Set(linkEntries.map((entry) => entry.data.url));
    expect(bundle.links).toHaveLength(linkEntries.length);
    for (const link of bundle.links) expect(declared.has(link.url)).toBe(true);
  });

  // The path segment a link is filed under is an OPAQUE id; the display names
  // live in the newest settings file's `listNameMap`, which is a tree. So a
  // resolved folder path is a chain of display names and never an id — and
  // `Books/Draw & Paint` also proves the ampersand survives a format that is
  // JSON rather than HTML (the interop parsers' decode rule does not apply here).
  it('resolves opaque list ids into display-name folder paths', () => {
    const paths = bundle.links.map((link) => link.folderPath);
    expect(paths).toContainEqual(['Books', 'Draw & Paint']);
    // The negative that matters, over every row rather than the one above: an
    // unresolved id would show up as a folder literally named `1647847073891-HN9X`.
    for (const segment of paths.flat()) expect(segment).not.toMatch(/^\d{13}-/);
  });

  // A link's list is whatever its NEWEST `sslts/` entry says, not the folder its
  // own path names — that path is only where it was first filed. This fixture
  // carries the real specimen: an entry under `links/My List/` that an sslt moved
  // into Books. Reading the path would silently file it in the wrong list.
  it('takes list membership from the sslt, not from the link path', () => {
    const moved = raw.find(
      (entry) => entry.path.startsWith('links/My List/') && entry.path.includes('1638624610018'),
    );
    const link = bundle.links.find((row) => row.url === moved?.data.url);
    expect(link?.folderPath).toEqual(['Books']);
  });

  // Archive and Trash cross as NAMED system lists rather than folders to be
  // matched by name — resolving `['Archive']` by name would mint a duplicate on
  // an account whose Archive has been renamed, and Trash is deliberately
  // unmatchable as a folder. The control is in the same case: the rows that are
  // in neither carry no `systemList` at all.
  it('names Archive and Trash instead of matching them as folders', () => {
    const system = bundle.links.filter((link) => link.systemList !== undefined);
    expect(system.map((link) => link.systemList).sort()).toEqual(['archive', 'trash']);
    for (const link of bundle.links) {
      if (link.systemList === undefined) expect(link.folderPath).toBeDefined();
      else expect(link.folderPath).toEqual([]);
    }
  });

  // Brace draws the deliberate/discovered title line in the same place we do, so
  // `custom.title` is the one file-carried title that becomes `customTitle`. The
  // extracted title on the SAME row must stay provisional — flattening the two
  // would freeze someone else's <title> as the user's own.
  it('keeps the user title and the extracted title apart on the same row', () => {
    const withCustom = bundle.links.filter((link) => link.customTitle !== undefined);
    expect(withCustom).toHaveLength(1);
    expect(withCustom[0].title).toBeDefined();
    expect(withCustom[0].title).not.toBe(withCustom[0].customTitle);
    // The other rows carry a title and claim nothing about who wrote it.
    for (const link of bundle.links) {
      if (link !== withCustom[0]) expect(link.customTitle).toBeUndefined();
    }
  });

  // The custom image crosses as a REFERENCE into the bundle's blob map, decoded
  // from its base64 data URL. Two halves, both needed: a ref with no blob writes
  // a link pointing at bytes that never arrived, and a blob with no ref is
  // uploaded and paid for forever with nothing displaying it.
  it('carries the custom image as a referenced blob, decoded', () => {
    const refs = bundle.links
      .map((link) => link.imageRef)
      .filter((ref): ref is string => ref !== undefined);
    expect(refs).toHaveLength(1);
    expect([...bundle.images.keys()]).toEqual(refs);

    const bytes = bundle.images.get(refs[0]);
    // Decoded, not the data URL as text: PNG's magic number.
    expect([...(bytes ?? []).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  // A pin crosses as an opaque ordering key — Brace stores LexoRank, and only the
  // ORDER means anything, so the orchestrator re-ranks into this library's own
  // keyspace. What has to survive the parse is WHICH link was pinned.
  it('marks the pinned link and only the pinned link', () => {
    expect(bundle.links.filter((link) => link.pinRank !== undefined)).toHaveLength(1);
  });

  // Tag ids are opaque in the path the same way list ids are, and resolve through
  // `tagNameMap` — matched by name alone, wherever they sit.
  it('resolves tag ids to display names', () => {
    const named = bundle.links.flatMap((link) => link.tagNames);
    expect(named).toEqual(['Todo']);
  });
});
