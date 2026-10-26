# Release notes

What each store’s “What’s new” field said for each version, one file per
version, kept here so the next set has something to match. They are written
once, pasted into the console by hand, and not revised after the version ships.

| folder                 | app                     | stores                 |
| ---------------------- | ----------------------- | ---------------------- |
| `bracemark-expo/`      | the iOS and Android app | App Store, Google Play |
| `bracemark-extension/` | the browser extension   | Firefox Add-ons        |

The Chrome Web Store has no release-notes field, and the web app and the
marketing site have no store.

## Writing a file

`<app>/<version>.md`, matching the version just bumped — `app.config.ts` for
bracemark-expo, `package.json` for the browser extension. One `## <store>`
heading per store, each over one ` ```text ` block holding exactly what gets
pasted. Write each store’s text for its own readers: the two expo stores
usually differ by a word or a line (iPad on one, tablets and foldables on the
other).

The shape:

```text
<the one change that matters most, in one sentence>

• <the next change>
• Fixed: <what the user saw go wrong, in their words>

Found a bug, or need help? bracemark.com/support
```

- **Lead with the change.** Both stores show two or three lines before “more”;
  a generic opener (“We always make improvements…”) spends them on nothing.
- **Name what changed, even when it is small** — “Fixes to sync and the link
  editors”, not “Bug fixes and improvements”.
- **Only what shipped** in this version, and nothing planned.
- **No version number** — both stores print it beside the notes.

Everything else is the voice in
[docs/brand-assets.md](../docs/brand-assets.md#the-voice), which holds this
folder like the rest of the repository’s public prose: no exclamation marks,
British spelling, contractions, the serial comma, _tap_ for the app, _link_
for the object, and no plan names, prices or limits.

## Checking

```bash
npm run check:release-notes
```

It fails on a file over a store’s character budget, a straight `'` or `"`, an
exclamation mark, a bare “extension”, a missing or unknown store section, and
an app whose current version has no notes file yet. The budgets are in
`tools/scripts/check-release-notes.mjs`. The rest of the voice is a judgement
and is not checked.
