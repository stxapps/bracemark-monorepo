# Web data-lifecycle release qualification

These checks own browser surfaces Playwright cannot drive honestly. Run them in
the supported production Chrome build against a disposable account. Do not stub
`showSaveFilePicker`: the native dialog and the file it creates are the boundary.

## DATA-EXPORT-WEB-RELEASE-001 — every offered format

`@DATA-EXPORT-WEB-RELEASE-001` `@release` `@online`

- [ ] Import the Phase 5 small Bracemark archive so the account has one link,
      one list, one tag, and one image.
- [ ] In Settings → Data → Export all data, choose **Bracemark backup**, export,
      and save the file through Chrome's native dialog. Verify the suggested and
      saved filename matches `Bracemark backup YYYY-MM-DD.zip`, then verify the
      receipt says `Exported 1 link and 1 file.`
- [ ] Repeat for **HTML bookmarks** and verify
      `Bracemark bookmarks YYYY-MM-DD.html` plus `Exported 1 link.`
- [ ] Repeat for **CSV** and verify `Bracemark bookmarks YYYY-MM-DD.csv` plus
      `Exported 1 link.`
- [ ] Repeat for **Plain text** and verify `Bracemark links YYYY-MM-DD.txt` plus
      `Exported 1 link.`
- [ ] Confirm all four files exist and are non-empty. Archive contents stay the
      unit/native-contract layer's responsibility.

## DATA-EMPTY-001 — a file still exists for an empty run

`@DATA-EMPTY-001` `@release` `@online`

- [ ] Use a fresh disposable account with no links.
- [ ] Export **Bracemark backup** through Chrome's native save dialog.
- [ ] Verify a non-empty `Bracemark backup YYYY-MM-DD.zip` file exists.
- [ ] Verify the receipt says: `The file was saved, but there were no links to
  put in it.`
