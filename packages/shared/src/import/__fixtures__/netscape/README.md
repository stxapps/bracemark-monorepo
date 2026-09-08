# Real Netscape bookmark exports

Eight files, each written by the browser or service it is named for — not by us
and not by hand. They are the specimens `../../netscape-exports.spec.ts` runs the
parser over; the reasoning for wanting real ones at all is in that file's header
and in `docs/testing.md`, _import specimens_.

**Verbatim, byte for byte.** Nothing here is trimmed, anonymized or reformatted,
which is the whole point: the moment one is edited it becomes a hand-written
fixture that agrees with our parser by construction, and it stops being evidence
about what a browser actually writes. `.prettierignore` carries an entry for this
directory so a repo-wide format run cannot rewrite them either. Regenerating is
not a thing you do — replacing one means fetching a new specimen from a real
producer.

## Provenance

Vendored from [shaarli/netscape-bookmark-parser][repo] (MIT), from
`tests/Fixtures/Encoder/input/` at commit
[`8f24323`](https://github.com/shaarli/netscape-bookmark-parser/commit/8f243234014c8f70eeb9307ebdecbca9f5c3b931).
Upstream collected them by exporting from each producer; the URLs in them are
that project's own test data, public since 2016.

[repo]: https://github.com/shaarli/netscape-bookmark-parser

| file                              | producer                                                       |
| --------------------------------- | -------------------------------------------------------------- |
| `chromium_nested.htm`             | Chromium / Chrome "Export bookmarks"                             |
| `firefox_nested.htm`              | Firefox "Export bookmarks to HTML"                               |
| `internet_explorer_11_nested.htm` | Internet Explorer 11 favorites                                   |
| `safari_folded.htm`               | Safari "Export bookmarks"                                        |
| `google_bookmarks_nested.htm`     | Google Bookmarks                                                 |
| `delicious.htm`                   | Delicious                                                        |
| `netscape_multiline.htm`          | Shaarli — multi-line `<DD>` descriptions                         |
| `netscape_extended.htm`           | Shaarli — a thumbnail `<a>` inside a `<DD>`                      |

## The MIT notice these files are redistributed under

```
Copyright (c) 2016-2021 the netscape-bookmark-parser contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
