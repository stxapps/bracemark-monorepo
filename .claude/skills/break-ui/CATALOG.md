# Worst-case catalog

Realistic values that break a Bracemark screen, grouped by what the screen
renders. Use the rows that apply to the fields in your Phase 1 table.

**Where** says how to get the value onto a screen:

- **seeded**: `plus-worst` already carries it. The quoted slug is the link's
  `worst-link-<slug>` id in `e2e/seed/worst.ts`.
- **seed it**: plausible and reachable, but not in the seed yet. Add it to
  `worst.ts` under that file's two rules, then delete all data and re-seed.
- **by hand**: a state, not data. A backup cannot carry it, so produce it on
  the device.

Limits are the ones in `docs/data-limits.md`, _what is bounded_. If a limit
there moves, the seed moves with it, because it imports the constants.

Hosts are `.invalid` / `.test` so nothing resolves. Keep it that way in
anything you add.

---

## Link titles

The row shows `customTitle ?? extraction.title ?? host(url)`.

| Value                                                               | Breaks                                                                    | Where                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| An og:title at `LINK_TITLE_MAX` (300), cut mid-word by `cleanTitle` | Two-line clamp, the card's height, the tooltip, the editor field          | seeded `title-at-cap`                                        |
| `كيفية إعداد Kubernetes على خادم منزلي: دليل شامل في 12 خطوة`       | Bidi inside an LTR row: the number and the Latin word move, ellipsis side | seeded `rtl`                                                 |
| `大規模なTypeScriptモノレポにおける…（2026年版）`                   | No spaces, breaks anywhere, fills the clamp edge to edge                  | seeded `cjk`                                                 |
| `วิธีตั้งค่าเราเตอร์ที่บ้าน…` (Thai)                                | No spaces, and marks above and below clipped by tight leading             | seeded `thai`                                                |
| `Đặng Thị Ngọc Hân: Hướng dẫn nấu phở…`                             | Stacked diacritics clipped under `overflow: hidden`                       | seeded `vietnamese`                                          |
| `Rechtsschutzversicherungsgesellschaften im Vergleich…`             | One word wider than a narrow column                                       | seeded `compound`                                            |
| `👩🏽‍💻 Shipping a side project…` as a user's `customTitle`             | ZWJ emoji first: `charAt(0)`, monograms, `.length`                        | seeded `emoji-first`                                         |
| `Tom &amp; Jerry: The &lt;b&gt;Complete&lt;/b&gt; Collection…`      | Must render as stored: never decoded, never as markup                     | seeded `entities`                                            |
| `Home`, three times, on three hosts                                 | Identical one-word titles: only the host tells them apart                 | seeded `home-1..3`                                           |
| `customTitle: 'ok'` over a long extracted title                     | Very short title, a tiny click target if the title is the link            | seeded `short-custom-title`                                  |
| No title: a `done` extraction of a page with no `<title>`           | The row falls back to the url                                             | seeded `tracking-url`                                        |
| A 300-unit title whose cut lands inside an emoji                    | `slice` on UTF-16 splits a surrogate pair: a lone `�` at the end          | seed it (contrived; only if the screen does its own cutting) |

## Urls and hosts

The url is **uncapped by design**: it is the link's identity
(`docs/data-limits.md`). A long url is never a "Fragile: add a limit" finding.

| Value                                                                | Breaks                                                       | Where                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------- |
| A newsletter tracking link, ~450 chars of `utm_*`, `fbclid`, `gclid` | Unbreakable: pushes the row's menu and date out              | seeded `tracking-url`       |
| A percent-encoded Thai path (`/wiki/%E0%B8%A7…`)                     | Unbreakable and unreadable: decode for display or not?       | seeded `thai`               |
| `https://例え.テスト/ブログ/…` (IDN host, extraction permanent)      | The host fallback: Unicode or punycode, the favicon lookup   | seeded `idn`                |
| `nas.home.invalid:5000/photo`, confirm-saved raw text                | No parseable host: `hostFromText`, the favicon, the monogram | seeded `raw-text`           |
| `…/installation` and `…/installation/`, same title                   | End-truncation makes two rows identical                      | seeded `trailing-slash-a/b` |
| `https://www.example.test/`                                          | `www.` is stripped for display; a bare-root path             | seeded `home-3`             |
| A url typed into the add form at 320px                               | The input, the "not a url, save anyway?" path                | by hand                     |

## Notes

| Value                                                                  | Breaks                                                        | Where                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------- |
| A note at `LINK_NOTE_MAX` (500), multi-line, an unbreakable url inside | The note badge, the editor's textarea growth, a preview of it | seeded `note-at-cap` |
| An Arabic note                                                         | Direction in the editor and in any preview                    | seeded `rtl`         |
| A one-line note on a link with no title                                | Note and url fallback side by side                            | seeded `raw-text`    |

## Tags

| Value                                                  | Breaks                                                                    | Where                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------ |
| One link with all `LINK_TAGS_MAX` (100) tags           | "+N" at its largest; the editor's chip field; bulk "add tag" to 101       | seeded `every-tag`       |
| A tag cut to `TAG_NAME_MAX` (a sentence used as a tag) | A chip wider than the row; the tag tree row; the picker                   | seeded on `note-at-cap`  |
| `customer-feedback-from-enterprise-onboarding`         | Unbreakable chip                                                          | seeded on `title-at-cap` |
| `Design` and `design`                                  | Case twins that look like one tag                                         | seeded on `compound`     |
| `a`, `⭐`, `読む`, `مهم`, `via:hn`                     | One letter, emoji-only, CJK, RTL, punctuation: chip width and sort order  | seeded                   |
| 100 tags in the sidebar and the pickers                | Every tree surface mounts every row: **known** (`docs/client-queries.md`) | seeded                   |

## Lists and the tree

| Value                                                                 | Breaks                                                                    | Where                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------- |
| A chain `TREE_MAX_DEPTH` (100) deep, "Imported" > "Bookmarks bar" > … | Indentation runs off the rail; breadcrumbs; "Move to"; the depth guard    | seeded, link `deepest` |
| A list name cut to `LIST_NAME_MAX` (200)                              | Sidebar row at rail 192px, the picker, the settings table, a dialog title | seeded `long-list`     |
| `قراءات لاحقة`, `あとで読む・技術記事まとめ`, `🦊 Side projects`, `A` | Direction, width, sort, a one-letter target                               | seeded                 |
| A user list named `Archive`, beside the system Archive                | Two identical names in one sidebar                                        | seeded `archive-twin`  |
| `Taxes` with exactly one link; `Someday` with none                    | "1 link" vs "1 links"; the empty state inside a user list                 | seeded                 |
| A name longer than 200 that arrived by sync or a pre-cap restore      | The reader must cope: the schema does not cap it                          | seed it                |
| A rename to a long name in progress                                   | The inline editor at the rail's width                                     | by hand                |

## Images

| Value                                                              | Breaks                                                               | Where                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------- |
| A 1200×80 panorama preview                                         | Distortion without cover; a card stretched wide                      | seeded `entities`         |
| An 80×1200 tall strip                                              | Distortion; a card blown out in height                               | seeded `thai`             |
| A mostly transparent logo                                          | Invisible against the matching theme                                 | seeded `transparent-logo` |
| An `imageId` whose blob is not in the archive (manifest `omitted`) | A broken image instead of the fallback; a spinner that never settles | seeded `missing-image`    |
| A failed or permanent extraction                                   | The monogram fallback and its size parity with a real preview        | seeded `failed`, `idn`    |
| A preview still downloading on a slow network                      | Layout shift without a fixed slot                                    | by hand (throttle)        |

## Numbers, counts and time

| Value                                                         | Breaks                                                    | Where                |
| ------------------------------------------------------------- | --------------------------------------------------------- | -------------------- |
| My List at exactly 101 (2 × `PAGE_SIZE` + 1)                  | The last "Show more" loads a single link: any off-by-one  | seeded               |
| The largest "+N"; "Imported 112 links"; counts of 0 and 1     | Widths, plurals                                           | seeded               |
| `createdAt` three days in the future (another device's clock) | The top row; "in 3 days" or "-3 days ago"                 | seeded `clock-skew`  |
| Just now, 1 minute, 1 hour, 1 day                             | "0 seconds ago"; singular units                           | seeded, first rows   |
| A 2009 bookmark                                               | Relative time that never switches to a date               | seeded `decades-old` |
| 1,000 links                                                   | Scroll, decode, paging: **volume belongs to `plus-full`** | `plus-full`          |

## States

| Value                                                           | Breaks                                         | Where                                |
| --------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| Pinned links with the longest title, an RTL title and every tag | The pinned block above the list                | seeded                               |
| Links in Trash and in Archive                                   | Restore, delete permanently, empty-trash copy  | seeded `trash`, `system-archive`     |
| A pending extraction (just saved)                               | The row before any title arrives               | by hand: save a `.invalid` url       |
| Bulk edit with the worst rows selected                          | The bulk bar, the tags dialog at 100 tags      | by hand                              |
| Search with no results; a 300-character query                   | The empty state; the search field              | by hand (`docs/search.md`)           |
| Offline, or sync failing                                        | Banners and the refresh pill over long content | by hand (`docs/local-first-sync.md`) |
| A locked list (Plus)                                            | The lock screen over a long name               | by hand (`docs/locks.md`)            |
| Free at its 200-link cap                                        | `LinkQuotaBanner` replacing the add form       | by hand: `free-full` (190) + 10      |

## Environment

Not data, but checked the same way: sign into the worst case, then change these.

| Condition                                                               | Breaks                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------- |
| Links rail at 192px, and at 400px (web, from `md`)                      | Every overflow above, in the tree and the list at once   |
| Viewport 320px (web): the rail becomes a drawer                         | The row, the topbar, dialogs                             |
| List layout and card layout (Settings → Misc)                           | Card height, preview aspect, clamp                       |
| Default font size raised (web); OS font scale at max (expo, capped 1.3) | Fixed heights that clip growing text                     |
| Dark mode                                                               | Transparent previews, hardcoded colours, invisible edges |
| Tablet / foldable / rotation (expo; `docs/safe-area.md`)                | The docked rail, a row stretched across a wide window    |
| Touch                                                                   | Hover-only row actions; targets under 44pt               |
| The iOS share extension's sheet; the browser extension's popup editor   | Their list and tag pickers with this account's 109 lists |
