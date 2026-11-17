# Bracemark source security review, November 2026

Prepared 17 November 2026. The review is ongoing and its coverage is partial. This report describes the state on that date and is not revised afterwards; a later review gets a report of its own, listed in [the index of reviews](README.md). The [October report](2026-10-21-source-review.md) stays as the record of what was known then.

This report summarises the second round of an AI-assisted review of selected source security boundaries, at [source revision f6e3a54](https://github.com/stxapps/bracemark-monorepo/tree/f6e3a542d8137682ace9899056def1064d0f8ff4). It covers two areas: cleanups that delete something because it is missing from a device, and copies of a web page kept with a link (read mode and screenshots). It also says what the release of 17 November carries, which is built from a later revision. It is not a whole-product audit, an external audit, or an assessment of the deployed service.

## Results and their limits

The saved decisions have not changed since October. No record was added, re-decided, or closed.

| Latest saved decision | Distinct records | Meaning                                                                                                                |
| --------------------- | ---------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Confirmed             |                4 | Historical source-review findings with a recorded consequence and an overall severity of low                           |
| Needs validation      |               19 | Source-grounded hypotheses whose decisive runtime, deployment, or policy facts remain unresolved; no severity assigned |
| Rejected              |                5 | The particular proposed security claim was not supported by its review; no severity assigned                           |

These counts are decisions about particular claims. They are neither a count of currently open vulnerabilities nor a measure of product coverage.

Nothing found in this round is a new record. A record is a claim that someone with less trust than the account’s owner could cross a boundary: another account, the server, or a page the owner visits. Every problem below affects only the owner’s own library, after a file failed to open, after changes arrived in an unlucky order, or when the input comes from a device or a backup the owner controls. One kind of input in this round does come from someone else: a web page the owner chooses to keep a copy of. What such a page could do is described under copies of a page. It reached no other account’s data, and its effect was on cost: time and memory on the owner’s device or on our link-extraction service. We report all of these as engineering problems with a stated consequence. That is not a claim that they are harmless.

Two of the problems were in the production web app until the release of 17 November: an overwrite of a preview the device could not open, and a preview reaching the server before its link. Both are described below. Both cost the owner’s own preview data, and both are fixed in that release.

## Method and attribution

The method is October’s. We adapted [Cloudflare’s security-audit skill](https://github.com/cloudflare/security-audit-skill) for focused source reviews; Cloudflare did not conduct this review or certify Bracemark. A session we direct reads a change set and states what it would have to find. A separate agent, starting from a fresh context with the earlier review and the changed source, reviews it and is not told the expected answer. Fixes are made by an AI agent under our direction, or by us, and are then rechecked the same way.

This round had separate reviews of the cleanups and the record they depend on, of the fixes to them, of the copies feature, of the fixes to that, and of everything up to the revision we planned to release. RECHECK-RESULT-PENDING

The session that ran the first of these reviews recorded that it ran on Claude Sonnet 5.5, and the reading of the release’s later changes ran on Claude Opus 5.5. The other sessions, and the separate reviewing agents, did not record which model they ran on, so we do not name one. A model name is not evidence of coverage or accuracy.

## Evidence boundary

Decisions rest on reading source and on running our own code on a development machine, in a separate copy of the source: the repository’s unit tests, small probes written against the same functions, and mutation tests. The reviews did not touch production, a production credential, or real users’ data.

One run used our staging deployment, with test accounts and existing end-to-end cases. Staging held a web build from 5 November, before every change described here, so that run says nothing about them. It did confirm, for the API deployed on staging, that the file route added in October refuses a request with no token or a bad one, and admits only the staging origin.

Nothing in this report has been retested on a device or against a running deployment of the changed code. A probe shows what a function does with a given input; it is not a test of a deployed service or of a device.

## Cleanups that delete by absence

### What was there before

Each device keeps its own copy of the library as encrypted files. Some tidying can only work by noticing what is not there. The web app deletes a link’s preview when the link is not on the device, and deletes image files that no link names. That is safe only if missing means gone. It can also mean that a file failed its integrity check and was skipped, that a sync stopped halfway, that changes arrived in a different order than they were written, or that a clock was wrong. A cleanup that reads any of those as gone turns one device’s problem into a deletion on every device, because the deletion syncs.

October’s fix gave each device a record of the files it could not open, and held the cleanups back unless that record is complete. Since then the same cleanups were added to the mobile apps, and a recheck opens a recorded file again after an hour, then a day, then weekly, and stores it if it now opens. The shared rules are in [`sync/sweeps.ts`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/shared/src/sync/sweeps.ts) and the record in [`sync/unreadable.ts`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/shared/src/sync/unreadable.ts).

The mobile record needed the mobile app’s first local database migration, [`runMigrations` in `db.ts`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/expo-react/src/data/db.ts). Every mobile build released before it skipped files without recording them. So a database that the migration brings up is treated as unproven: neither cleanup runs on it until one full listing of the account has recorded what this device cannot open. The same applies to a web store from before the record. One gap is left there: a web tab still running a build from before the record can skip a file without recording it.

### What the review found

The separate review found no path in ordinary operation that deletes a file another device still names. The record, the gate on the cleanups, the forced listing after the migration, and the recheck did what they claim on web and mobile, in our test harness. It then found what the record did not reach.

| Problem                                               | Consequence                                                                                                                                                                                                                                                                                                                                                                                   | Where it was                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Writers ignored the record                            | Only the cleanups read it. A link whose preview file could not be opened looked like a link with no preview, so the app fetched a new one and uploaded it over the server’s copy. The recheck then saw a newer file and dropped the path from the record, and after the 30-day grace the cleanup of unreferenced files could delete what the unreadable file had pointed to, on every device. | The overwrite was in the production web app; the deletion was in no release |
| A preview could reach the server before its link      | Changes go up in batches of up to 500, in path order, and a preview’s path sorts before its link’s. Between two batches, another device could see a preview with no link and delete it. In the cases reproduced, the cost was a preview the app can fetch again                                                                                                                               | In the production web app                                                   |
| The grace period used the device’s clock              | A clock set well ahead would shorten the 30 days                                                                                                                                                                                                                                                                                                                                              | In no release                                                               |
| The lock cleanup ignored the record                   | The cleanup of device-local list locks deleted the lock of a list that was only unreadable                                                                                                                                                                                                                                                                                                    | Predates this round                                                         |
| A failed cycle could leave the record marked complete | A listing that failed partway could still let the cleanups run                                                                                                                                                                                                                                                                                                                                | In no release                                                               |

The review also found six statements in our comments and design notes that claimed more than the code does, and mutation tests with surviving mutants where no test pinned a rule.

### What we changed, and how it was checked

- A link whose preview file is recorded as unreadable is no longer rewritten ([`assertExtractionWritable`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/web-react/src/data/mutations.ts), and [its mobile twin](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/expo-react/src/data/mutations.ts)). A capture started on such a link fails with a generic error until the recheck opens the file.
- Previews are queued after their links, so a batch boundary cannot separate them in the wrong order.
- The grace period cannot run ahead of the newest time the server has reported to that device.
- The lock cleanup spares a list that is recorded as unreadable.
- A cycle that fails partway no longer leaves the record marked complete.
- The six statements were corrected, and the mutants that mattered were killed by new tests.

A separate agent rechecked the fixes. It re-ran the earlier reproductions against them and found the routes closed, with no new deletion by absence. It also found small things. Two were introduced by the fixes themselves: the new refusal could stop the iOS share sheet’s queue of saved drafts from saving the drafts after it, and a refused write left files it had already uploaded with nothing pointing to them. Both were fixed. Others predate the fixes: two other writers, removing a kept copy and a backup restore, can still overwrite a recorded preview; and a link whose own upload fails can leave its preview committed without it. That fix, and every change since the recheck, was read by us and by tests, not by a separate agent.

### What we decided to leave

- **A file that can never be opened is never deleted, and the owner is not told.** There is nothing the owner could do about it, and nothing about it the app could show. The cost is that on that device the cleanup of unreferenced files stays off, so those files stay until the file opens.
- **A restore on our side may look like a deletion.** If the server were restored to an earlier point after devices had synced, a device cannot always tell a restore from a deletion by the owner. Fixing that needs the server to number its log. It is not built, and [the design record](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/docs/local-first-sync.md) says so.
- **Some libraries share one custom image between links.** Earlier imports did that. Changing or deleting the image on one of those links removes it under the others. New imports give each link its own.
- **A replaced image is deleted before its replacement uploads.** If the upload then fails, the old one is already gone.
- **The 30 days count from upload,** not from the owner’s last change to the link, so a file can have less time left than expected.
- **The mobile migration has not run on a device.** It was tested against a file shaped like the first release’s, in the test harness only.

## Copies of a page

### The boundary

A link can keep a copy of its page: the article’s text for read mode, and a screenshot. A copy comes from a stranger’s page. It is captured by the browser extension, the mobile app’s capture screen, Safari’s share sheet on iPhone, or read mode in our link-extraction service; and a copy can also arrive inside a backup or from another of the owner’s devices. It is stored, synced, and drawn in the app that holds the account’s data key. The question was what a stranger’s page could do with that.

### What held

A stranger’s page does not become markup, script, an attribute, an unchecked address, or an image address through any of those routes. A copy is drawn as text nodes, never as markup. A link is kept only if it is an absolute http or https address, and it is checked again when it is drawn. Images come only from the pack stored beside the copy. The review drew a hostile document and found no script in the result, and tested 27 kinds of address against the link check. The format is in [`reader-doc.ts`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/shared/src/reader/reader-doc.ts) and [`reader-doc-core.ts`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/shared/src/reader/reader-doc-core.ts).

### What did not, and what we changed

The size limits lived only in the converter that builds a copy, and on two routes that converter runs inside the page. So a forged message from a page, a backup, or a compromised device could store a copy of any size; the review stored 200 KB of gzip that decompressed to 200 MB. In the link-extraction service, a page of nested elements made the reader’s cost grow with roughly the cube of its depth, and an 11 KB page took three to six seconds. A hostile `robots.txt` cost 3.4 seconds for one answer. The image pack’s own index chose the type the browser was told to decode it as.

We added limits where a copy is stored and where it is opened, on every route ([`readerDocWithinCaps`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/shared/src/reader/reader-doc.ts)); ceilings on decompression; a check of the image pack’s actual bytes; a step budget for `robots.txt`; and depth and element limits in the link-extraction service.

A separate agent rechecked that work and found it partly closed. Closed: the pack decoder, the `robots.txt` budget, the limits at the store on all five routes, streaming decompression on the web, and the capture screen’s handling of links that leave the web. No honest copy was lost. Not closed:

- The link-extraction service’s depth and element limits did not bound its cost. A 74 KB page passed both and took 23.5 seconds, and the page was parsed before either was checked.
- The mobile app’s ceiling on how much a copy may decompress to did not bound memory, because the library decompresses a whole chunk before it can stop. One MiB of gzip used about 3 GB, which we reproduced.
- The mobile app’s image fetch did not stream on the phone’s network stack, so its size limit applied after the whole response was read.
- On Android, a page that opens a new window might reach the system browser without passing the capture screen’s navigation check. Unverified.

We fixed those. The mobile app now feeds the decompressor in [4 KiB slices](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/packages/expo-react/src/lib/reader-doc-bytes.ts), and its image fetch uses a streaming client. The capture screen on Android no longer opens new windows. A test now fails if any of those is undone.

The fix for the link-extraction service did not hold. A third separate review, of everything up to the revision we planned to release, found two ways past it:

- **The check before the parse was an estimate.** It read the page’s text and guessed its nesting, and the parser underneath linkedom nests markup the guess did not count: it ignores `/>` on an element that is not void, never closes `<thead>` or `<colgroup>` by itself, and closes a `<p>` only when it is the innermost element. Pages of about 1 MB built from those passed the check and took 7 to 11 seconds to parse in the Workers runtime. The same estimate refused an honest page whose blocks left an inline element open.
- **Readability’s cost grows with width, not only depth.** It reads a parent’s list of children again after each sibling it adds to the article, and linkedom builds that list afresh each time, so 59,000 short sibling paragraphs took 173 seconds, at 2% of the cap.

The review also found that the mobile app’s decoder, with its new slices, could stall on a compressed copy whose header never ends (4 MB took 4.5 seconds), and that the iPhone share sheet’s new copy file, described under the release below, was read whole before any size check.

We fixed those. The link-extraction service now runs the same parser over the page before it builds anything, counting what it opens and closes, and stops at the depth and element limits and at a limit on text runs and comments ([`read-mode.ts`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/apps/bracemark-extractor/src/lib/read-mode.ts)). The walk after the parse adds each parent’s child count squared to the cost. Production also sets the Worker’s own CPU limit to 5 seconds, so a shape no check foresaw ends the request instead of running for minutes. The mobile decoder refuses a copy whose header is still unread after 64 KiB. The share sheet drops a copy past the capture cap before writing its file, and the app checks the file’s size before reading it. RECHECK-RESULT-PENDING

These stay open:

- **The limits are a judgement.** We chose them by running them over 391 HTML pages on our own disk, none of which they refused. They are not calibrated on pages from the web, and no count prices every shape a page could pick, which is why the CPU limit is there.
- **The Android new-window rule has not been seen on a device.**
- **A page in the Android capture screen can start a download** into the public Downloads folder. That predates this round, and the capture screen has no way to refuse it without changing the WebView library.

We left three smaller items, each of which needs a forged capture or a backup the owner restores: the capture screen does not cap how many images a capture names; the limits count characters, not elements, so a copy of many empty elements passes them, with a cost to draw it on a device that we have not observed; and the browser extension’s route refuses an honest copy with one block of text past about two million characters.

## What is in each release

On 17 November we deployed the web app, our API, and the link-extraction service with the fixes this report describes, and sent an Android update to Google Play and a browser extension update to the Chrome Web Store and Firefox Add-ons. Each update reaches a device once its store approves it; until then, the Android app on Google Play carries the October fixes and none of this round’s. The iOS app is waiting for its first App Store review, and that first version carries none of this round’s changes.

None of the copies feature was in a release before 17 November, apart from an early version of the browser extension’s capture in its 1.2.0 builds. The reader, capture in the mobile app, read mode in the link-extraction service, and every limit above arrive with that release.

The release is built from [revision 4c3f172](https://github.com/stxapps/bracemark-monorepo/tree/4c3f172c82f1928bae9d72c33a5ad201dd495ec3), later than the one this report pins. The changes since add work on the screens around copies, the share sheet, and the list pickers. We read the ones that touch what this review covers:

- The iPhone share sheet now hands Safari’s copy to the app through a file in the app’s shared container, instead of inside the saved draft. The draft names the file; the app accepts only a name of the form the sheet creates, reads the file only for the account the draft belongs to, applies the same checks and limits as any other copy before storing it, and deletes it. A file no draft names is deleted by the app once it is an hour old.
- The capture screen and the reader were rearranged, and gained a full-window screenshot viewer. The capture screen’s navigation controls are unchanged, and a screenshot is still drawn only as an image.
- The web app starts a sync after deleting all data, so the device shows the empty library at once.

The third review read these too. Only the share sheet’s change needed a fix: the file was read whole before any size check, as described above.

## Unresolved work

The 19 needs-validation records are not low-confidence confirmed vulnerabilities. They remain unresolved because a specific fact could change the decision, and this round decided none of them again. The October report’s list of missing evidence still applies.

Three changes since October have had no review beyond our own reading of them: a per-account rate limit and a monthly transfer budget in the API, and the iOS share extension’s native code, which we now keep in this repository.

Open facts that need a device or a deployment:

- The mobile migration on a real first-release database, on iOS and Android.
- Android’s handling of a page that opens a new window in the capture screen.
- Whether the phone’s network stack reads a response in pieces.
- How a deployed Worker’s CPU limit treats a page near the link-extraction service’s cap.
- What a real iOS or Android build reports for a file that fails to open.

## Next evidence

The next evidence has to be a build with these changes in it, run by us on a device or against staging with test accounts. Staging, as of this round, held an older build. Repeating source questions cannot settle device behaviour, provider limits, or real interleavings. Any resulting decision, fix check, or retest should state its revision, platform, scope, and remaining limits.

No completion date is asserted here. This work is not an external professional audit, and we have not commissioned one.

## What you can check

The [source repository](https://github.com/stxapps/bracemark-monorepo) is public. You can read the mechanisms described here at the revision linked above. Source review does not prove which build was served to your browser or installed on your device, and this report does not establish release provenance or effective deployment settings.

If you find a security issue, please follow the [security reporting policy](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/SECURITY.md) and contact [security@bracemark.com](mailto:security@bracemark.com). Send vulnerability details privately rather than opening a public issue.
