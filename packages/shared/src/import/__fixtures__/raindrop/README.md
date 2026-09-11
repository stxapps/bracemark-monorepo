# A real Raindrop.io export, both ways

Two files, both written by Raindrop.io's own "Export" from one account at one
moment: `raindrop.html` (its Netscape bookmarks file) and `raindrop.csv` (its
CSV). They are the specimens `../../raindrop-exports.spec.ts` runs the parsers
over; the reasoning for wanting real ones at all is in `docs/testing.md`,
_import specimens_.

**Verbatim, byte for byte**, like the files in `../netscape` — nothing trimmed,
anonymized or reformatted, and `.prettierignore` carries an entry for this
directory. Only the filenames were changed; Raindrop names both after an export
id. Replacing one means exporting again, and then replacing **both**, because
the spec's main claim is that the two files describe the same library.

## Provenance

A throwaway account made to produce these, filled by hand with public pages and
with the cases worth having in mind:

- a collection four levels deep, and a sub-collection whose name has `&` in it
- two collection names with a slash in them, one padded (`SEO / AEO`) and one
  not (`AEO/GEO`) — which the CSV's ` / ` separator can and can't tell apart
- a link with three tags, and a tag shared by two links
- a multi-line note; a note and two highlights on one link; highlights without
  a note
- two favorites, one of them in Unsorted
- a title the user renamed in Raindrop (`JRO Tools Youtube Tutorial` — the
  page's own title is in the CSV's `excerpt`)
- titles with `"`, `'`, commas, Thai text and an invisible U+202D bidi control
  copied from the page
- a Google redirect URL whose `&`s the HTML leaves unescaped
- one link in Trash — which is in **neither** file: Raindrop leaves Trash out
  of both exports

What it doesn't cover: a note on a highlight, which is a paid Raindrop feature.
