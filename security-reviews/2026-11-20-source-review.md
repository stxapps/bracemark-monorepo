# Bracemark source security review, November 2026

Prepared 20 November 2026. The review is ongoing and its coverage is partial. This report describes the state on that date and is not revised afterwards; a later review gets a report of its own, listed in [the index of reviews](README.md). The [October report](2026-10-21-source-review.md) stays as the record of what was known then.

This report summarises the second round of an AI-assisted review of selected source security boundaries, at [source revision f6e3a54](https://github.com/stxapps/bracemark-monorepo/tree/f6e3a542d8137682ace9899056def1064d0f8ff4). It covers two areas: cleanups that delete something because it is missing from a device, and copies of a web page kept with a link (read mode and screenshots). It also says what the release of 20 November carries, which is built from a later revision. It is not a whole-product audit, an external audit, or an assessment of the deployed service.

## Results and their limits

The saved decisions have not changed since October. No record was added, re-decided, or closed.

| Latest saved decision | Distinct records | Meaning                                                                                                                |
| --------------------- | ---------------: | ---------------------------------------------------------------------------------------------------------------------- |
| Confirmed             |                4 | Historical source-review findings with a recorded consequence and an overall severity of low                           |
| Needs validation      |               19 | Source-grounded hypotheses whose decisive runtime, deployment, or policy facts remain unresolved; no severity assigned |
| Rejected              |                5 | The particular proposed security claim was not supported by its review; no severity assigned                           |

These counts are decisions about particular claims. They are neither a count of currently open vulnerabilities nor a measure of product coverage.

Nothing found in this round is a new record. A record is a claim that someone with less trust than the account’s owner could cross a boundary: another account, the server, or a page the owner visits. Every problem below affects only the owner’s own library, after a file failed to open, after changes arrived in an unlucky order, or when the input comes from a device or a backup the owner controls. One kind of input in this round does come from someone else: a web page the owner chooses to keep a copy of. What such a page could do is described under copies of a page. It reached no other account’s data, and its effect was on cost: time and memory on the owner’s device or on our link-extraction service. We report all of these as engineering problems with a stated consequence. That is not a claim that they are harmless.

Two of the problems were in the production web app until the release of 20 November: an overwrite of a preview the device could not open, and a preview reaching the server before its link. Both are described below. Both cost the owner’s own preview data, and both are fixed in that release.

## Method and attribution

The method is October’s. We adapted [Cloudflare’s security-audit skill](https://github.com/cloudflare/security-audit-skill) for focused source reviews; Cloudflare did not conduct this review or certify Bracemark. A session we direct reads a change set and states what it would have to find. A separate agent, starting from a fresh context with the earlier review and the changed source, reviews it and is not told the expected answer. Fixes are made by an AI agent under our direction, or by us, and are then rechecked the same way.

This round had separate reviews of the cleanups and the record they depend on, of the fixes to them, of the copies feature, of the fixes to that, of everything up to the revision we planned to release, of the fixes that review led to, of the change after those to how the link-extraction service weighs a page, of the fixes that review led to, and of the changes made after that. The last of these found nothing to fix in the code, and two sentences in this report that claimed more than they should, which we corrected.

The session that ran the first of these reviews recorded that it ran on Claude Sonnet 5.5, and the reading of the release’s later changes ran on Claude Opus 5.5. The other sessions, and the separate reviewing agents, did not record which model they ran on, so we do not name one. A model name is not evidence of coverage or accuracy.

## Evidence boundary

Decisions rest on reading source and on running our own code on a development machine, in a separate copy of the source: the repository’s unit tests, small probes written against the same functions, and mutation tests. The reviews did not touch production, a production credential, or real users’ data.

One run used our staging deployment, with test accounts and existing end-to-end cases. Staging held a web build from 5 November, before every change described here, so that run says nothing about them. It did confirm, for the API deployed on staging, that the file route added in October refuses a request with no token or a bad one, and admits only the staging origin.

Apart from the mobile migration on an Android tablet and an iPhone, described under what we changed in the cleanups, nothing in this report has been retested on a device or against a running deployment of the changed code. A probe shows what a function does with a given input; it is not a test of a deployed service or of a device.

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

On 20 November the mobile migration ran on two devices against our staging server, each updated in place to a build of this release. An Android tablet held a library from the first Android release. An iPhone held a library from a build of the first iOS version, the one waiting for App Store review; its database read version 0 before the update and version 1 after it, with the same library and the migration’s four columns. On both, the library opened and synced.

### What we decided to leave

- **A file that can never be opened is never deleted, and the owner is not told.** There is nothing the owner could do about it, and nothing about it the app could show. The cost is that on that device the cleanup of unreferenced files stays off, so those files stay until the file opens.
- **A restore on our side may look like a deletion.** If the server were restored to an earlier point after devices had synced, a device cannot always tell a restore from a deletion by the owner. Fixing that needs the server to number its log. It is not built, and [the design record](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/docs/local-first-sync.md) says so.
- **Some libraries share one custom image between links.** Earlier imports did that. Changing or deleting the image on one of those links removes it under the others. New imports give each link its own.
- **A replaced image is deleted before its replacement uploads.** If the upload then fails, the old one is already gone.
- **The 30 days count from upload,** not from the owner’s last change to the link, so a file can have less time left than expected.

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

We fixed those. The link-extraction service now runs the same parser over the page before it builds anything, counting what it opens and closes, and stops at the depth and element limits and at a limit on text runs and comments ([`read-mode.ts`](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/apps/bracemark-extractor/src/lib/read-mode.ts)). The walk after the parse adds each parent’s child count squared to the cost. Production also sets the Worker’s own CPU limit to 5 seconds per request, so a shape no check foresaw ends the request instead of running for minutes. The mobile decoder refuses a copy whose header is still being read after 16 slices (64 KiB). The share sheet drops a copy past the capture cap before writing its file, and the app checks the file’s size before reading it.

A fourth separate review rechecked those fixes. It found the check before the parse exact against the parser, linear, and refusing every earlier shape; the mobile decoder’s rule true of the library and not tripped by honest data; and the share sheet’s size checks correct. It found the cost still not bounded by the checks. Neither counted attributes, and the walk after the parse priced elements only, while linkedom keeps an element’s attributes in the same list as its children, and text runs and comments are nodes too, so Readability walks all of them. Four pages passed both checks and took 3.9 to 207 seconds in the Workers runtime; the slowest was 240 nested elements around one paragraph with about 155,000 attributes. Only the CPU limit would have stopped them.

We changed the walk to weigh nodes: each element’s depth squared is multiplied by one plus its attributes and its children that are not elements, and each parent’s element children by its child nodes and attributes, against a cap of 4e7.

A fifth separate review rechecked that change. It found the weight correct, linear, and pricing the shapes it was built for: each, scaled to the largest page that passes, took at most 2.4 seconds in the Workers runtime. But not all of Readability’s slow work is a walk over nodes. Pages that passed both checks took 2.5 to 135 seconds there: a shallow element with 40,000 attributes, which Readability copies one at a time when it renames the element; a long title compared word by word with a long heading; two regular expressions that retry from every character of a long `srcset` or `<meta property>`; an end-of-text trim in our own converter, run on a `<pre>` of spaces; and one long run of text deep in the tree, which Readability reads again for every element above it. The change refused no page on our disk, but two pages we generated to look honest, a 1 MB docs page with a large sidebar and a deep comment thread, were newly refused.

We fixed those. The walk also charged each element its attributes squared and each run of text its length times its depth, against the same cap. The rest was made linear: the title comparison uses a set, giving the same answer; the attributes Readability would copy from a wrapper `<div>` down a chain are removed first, since nothing after reads them; whitespace in `<meta property>` is collapsed; a `srcset` the regular expression would retry over is dropped; and the converter trims without a regular expression.

A sixth separate review read those fixes. It found the string work correct and now linear: the title comparison gave Readability’s answer in 400,000 comparisons, removing the wrapper attributes changed no output on 616 pages, and the `srcset` rule matched the regular expression on every string tried, though it also drops a few valid but unusual forms (a leading or doubled comma, an `h` descriptor), where the image keeps its `src`. Every earlier slow page, scaled to the largest that passed, took at most 2.4 seconds. But it found the cost still not bounded. Readability repeats some of its work: it reads an embedded element’s attributes again under every container above it, and it runs the whole article search up to four times when the article it finds is short. The walk charged that work once. A 19 KB page passed both checks and took 175 seconds in the Workers runtime; only the CPU limit would have stopped it. It also found that charging text by its depth refused a plain 1 MB article in 15 wrappers, which reads in under a quarter of a second.

So we stopped predicting that work and count it instead. While Readability and our converter run, the service counts the reads that work goes through — each list of attributes or children the parser builds, each piece of text it assembles — weighted by what each costs, charges each retry what one more pass of the page was predicted to cost, and stops the read past a budget. The text term is gone from the walk. None of 616 HTML pages on our disk is refused, and a generated 1 MB article 40 wrappers deep spends about a third of the budget. The walk still refuses some honest pages that Readability reads in a quarter of a second: more than about 4,350 sibling paragraphs near the top of a page (a book on one page), 3,250 under 40 wrappers, or 1,700 there when each holds a link and an emphasis (650 KB). Its width term charges every parent as if it were the one Readability’s sibling loop runs over. We left it for this release, since that term is what stops 59,000 sibling paragraphs taking 173 seconds; a browser-extension copy of such a page is unaffected. Every page the reviews built to be slow, scaled to the largest page the checks and the count accept, took at most about 2.5 seconds in the Workers runtime, and the 175-second page under 0.8. That covers the shapes found, not every shape: the count sees only the reads it wraps, so the CPU limit stays as the backstop. A test fails if the count, its budget, the weight on attributes or on text, or the charge for a retry is removed.

A seventh separate review read these changes. It found the cost now bounded by the checks. Every page the earlier reviews built to be slow is stopped by the count, the 175-second page in about 0.8 seconds; the slowest page the checks accept, of 26 shapes each scaled to the budget, took 2.45 seconds in the Workers runtime, and a page the count refuses spends at most about 2.9 seconds before it stops. It found the count safe to share between requests, because nothing inside a counted read waits; the code's split into four files changed no behaviour; and removing the text term let the long article through. It also found the count's weights, set on Node, up to about eight times too low in the Workers runtime for pages heavy in attributes, which is why a read can take about 3 seconds rather than under one. That is a looser bound than the weights suggest, not a missing one, and we left the weights for a later release. Its mutation tests killed every mutant of the count's budget, its weights, its reset and the retry charge; two survivors were harmless (the count's fixed charge per read, and the count on children, which the walk already prices).

These stay open:

- **The limits are a judgement.** We chose them by running them over 616 HTML pages on our own disk, none of which they refused. Run since over the 52 public pages from the web that the service could read, fetched and read the way it reads them, they refused none either, and the closest page came to a quarter of each limit. Fifty-two pages are not real traffic, and no count prices every shape a page could pick, which is why the CPU limit is there.
- **The Android new-window rule has not been seen on a device.**
- **A page in the Android capture screen can start a download** into the public Downloads folder. That predates this round, and the capture screen has no way to refuse it without changing the WebView library.

We left three smaller items, each of which needs a forged capture or a backup the owner restores: the capture screen does not cap how many images a capture names; the limits count characters, not elements, so a copy of many empty elements passes them, with a cost to draw it on a device that we have not observed; and the browser extension’s route refuses an honest copy with one block of text past about two million characters.

## The opt-in to server extraction

No address leaves the web app for the link-extraction service unless the user has turned server extraction on. While fixing a flaky test we found that the code fetching previews and site icons checked that setting, then waited for a local read, and then made the request without checking again. If the user turned the setting off during that read, one more request could still go out. For site icons this was in the production web app until the release of 20 November; the preview code had not been released. Both now check again after every wait. The sixth review found every path checked, and two of the checks without a test; the seventh found a test for each.

## What the mobile capture screen keeps

The mobile app’s capture screen used to keep a copy or update a preview only while the page on screen had the saved link’s own address. A link that redirects, such as a shortened link, a mobile site or a sign-in page, left both buttons off with nothing to go back to. Now both take the page on screen, whose site the top bar names, and only if the page answering is the one shown when the user tapped. A page with no web address of its own, such as a blank page, is never kept. The sixth review found nothing protected lost beyond that choice: a user can file a page a link led to under that link. The seventh found the rule for a page with no address held by a test, and nothing honest refused.

## What is in each release

On 20 November we deployed the web app, our API, and the link-extraction service with the fixes this report describes, and sent an Android update to Google Play and a browser extension update to the Chrome Web Store and Firefox Add-ons. Each update reaches a device once its store approves it; until then, the Android app on Google Play carries the October fixes and none of this round’s. The iOS app is waiting for its first App Store review, and that first version carries none of this round’s changes.

None of the copies feature was in a release before 20 November, apart from an early version of the browser extension’s capture in its 1.2.0 builds. The reader, capture in the mobile app, read mode in the link-extraction service, and every limit above arrive with that release.

The release is built from a later revision than the one this report pins. The seventh review read the last of the read-mode changes at [revision e2305d9](https://github.com/stxapps/bracemark-monorepo/tree/e2305d9f67093f105b6a1c0c11c4eb4f9adb800f). Which commit each deployed service and each store build carries is recorded by a tag on that commit in the source repository, made when it ships: `web/`, `api/` and `extractor/` for a deploy, `android/`, `chrome/` and `firefox/` for a store release. The changes since the pinned revision add work on the screens around copies, the share sheet, and the list pickers. We read the ones that touch what this review covers:

- The iPhone share sheet now hands Safari’s copy to the app through a file in the app’s shared container, instead of inside the saved draft. The draft names the file; the app accepts only a name of the form the sheet creates, reads the file only for the account the draft belongs to, applies the same checks and limits as any other copy before storing it, and deletes it. A file no draft names is deleted by the app once it is an hour old.
- The capture screen and the reader were rearranged, and gained a full-window screenshot viewer. The capture screen’s navigation controls are unchanged, and a screenshot is still drawn only as an image.
- The web app starts a sync after deleting all data, so the device shows the empty library at once.
- The iPhone share sheet’s queue now waits for the account’s plan before deciding whether to keep a Safari copy, and keeps it when no answer can come (offline, or the request failed, with no plan cached). The plan’s limit on copies is checked by the app, not the server, so that choice favours a paying account: a free account kept offline keeps the copies it shares until its plan is known. The fourth review found this works as described.

The third review read these too. Only the share sheet’s change needed a fix: the file was read whole before any size check, as described above.

## Unresolved work

The 19 needs-validation records are not low-confidence confirmed vulnerabilities. They remain unresolved because a specific fact could change the decision, and this round decided none of them again. The October report’s list of missing evidence still applies.

Three changes since October have had no review beyond our own reading of them: a per-account rate limit and a monthly transfer budget in the API, and the iOS share extension’s native code, which we now keep in this repository.

Open facts that need a device or a deployment:

- Android’s handling of a page that opens a new window in the capture screen.
- Whether the phone’s network stack reads a response in pieces.
- How a deployed Worker’s CPU limit treats a page near the link-extraction service’s cap. A read-mode request of five pages, each built to reach the count’s budget, would cost about 3 seconds each in our test runtime, so it would meet the 5-second limit and fail as a whole.
- What a real iOS or Android build reports for a file that fails to open.

## Next evidence

The next evidence has to be a build with these changes in it, run by us on a device or against staging with test accounts. Staging, as of this round, held an older build. Repeating source questions cannot settle device behaviour, provider limits, or real interleavings. Any resulting decision, fix check, or retest should state its revision, platform, scope, and remaining limits.

No completion date is asserted here. This work is not an external professional audit, and we have not commissioned one.

## What you can check

The [source repository](https://github.com/stxapps/bracemark-monorepo) is public. You can read the mechanisms described here at the revision linked above. Source review does not prove which build was served to your browser or installed on your device, and this report does not establish release provenance or effective deployment settings.

If you find a security issue, please follow the [security reporting policy](https://github.com/stxapps/bracemark-monorepo/blob/f6e3a542d8137682ace9899056def1064d0f8ff4/SECURITY.md) and contact [security@bracemark.com](mailto:security@bracemark.com). Send vulnerability details privately rather than opening a public issue.
