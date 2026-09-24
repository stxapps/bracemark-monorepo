# Native release qualification

These checks cover hardware that the simulator, the emulator and Maestro cannot
represent honestly. Record the device model, OS version, app build, build commit,
and pass/fail result outside the repository with the rest of the release
evidence. Never put account credentials or lock passwords in that record.

Every other lock boundary — the gate on a cold start, a wrong password, the
covering lock, manual relock, auto-relock after the grace window — is automated
(`LOCK-APP-002`, `LOCK-LIST-001`, `LOCK-AUTORELOCK-001`). What is left here is
the biometric fast-path, which `expo-local-authentication` hands to the OS: a
simulator's enrolled-biometry toggle proves the app calls the prompt, not what a
real sensor, a real enrolment change or the platform's lockout does to it
(docs/locks.md, _biometric unlock_).

Use an account on Plus (setting a lock is the `locks` lever) and a build installed
on the device as described in docs/device-testing.md and docs/expo-build.md.

## iPhone biometric unlock

`LOCK-BIOMETRIC-RELEASE-001` `release` `online` `ios`

On a real iPhone with Face ID or Touch ID enrolled:

1. Settings → Misc: set an app lock. Confirm the "Unlock with Face ID" (or Touch
   ID) switch appears only now, turn it on, and confirm the OS asks once.
2. Settings → Lists: lock a list, then choose "Enable Face ID" from its row menu.
3. **Success.** Force-quit and relaunch. The app gate prompts on its own, once;
   authenticate and confirm the links screen opens. Browse the locked list and
   confirm its pane prompts and opens it the same way.
4. **Cancel falls back to the password.** Relaunch, cancel the prompt, and
   confirm the password field is focused-ready, no second prompt loops, and the
   real password unlocks. A wrong password is still refused.
5. **The device passcode is not a fallback.** Fail biometry until the OS offers
   the passcode; confirm Bracemark does not accept it (`disableDeviceFallback`).
6. **Auto-relock is a glance.** Unlock, background the app for more than a
   minute, return, and confirm the prompt re-appears and one glance opens it.
7. **Disable never unlocks.** Turn the switch off and relaunch: the gate asks for
   the password, with no biometric button.
8. **Enrolment changes.** Remove all enrolled faces/fingers in iOS Settings (or
   turn biometry off for Bracemark), relaunch, and confirm the gate shows no
   biometric button and the password still unlocks. Re-enrol and confirm
   re-enabling works.

## Android biometric unlock

`LOCK-BIOMETRIC-RELEASE-002` `release` `online` `android`

On a real Android device with a fingerprint or face unlock enrolled, repeat steps
1–8 above with the platform's labels. Additionally confirm that the prompt is the
system BiometricPrompt sheet and that dismissing it with the back gesture behaves
as a cancel (step 4), not as a navigation out of the gate.

## Native export share surfaces

`DATA-EXPORT-NATIVE-RELEASE-001` `release` `online` `ios` `android`

Run this once on a supported iPhone and once on a supported Android device with a
disposable account containing the Phase 5 small archive's link and image:

1. Settings → Data → Export all data: keep **Bracemark backup** selected and tap
   Export all data.
2. Confirm the operating system share surface opens over Bracemark and offers a
   Files/download destination. Save the file and verify its name matches
   `Bracemark backup YYYY-MM-DD.zip`.
3. Return to Bracemark and verify the receipt says `Exported 1 link and 1 file.`
   Tap **Save file…** and confirm the share surface can be presented again.
4. Select **HTML bookmarks**, export it, save it, and verify the filename matches
   `Bracemark bookmarks YYYY-MM-DD.html` and the receipt says `Exported 1 link.`
5. Confirm both files exist and are non-empty. Their contents are verified at the
   unit/native-contract layer; this check owns file creation and OS hand-off.

## Store purchases

`IAP-NATIVE-001` fetches the App Store product on the iOS simulator and opens and
cancels StoreKit's sheet; `IAP-ENTITLEMENT-001` proves each client opens its
plan gates from a `manual` grant. Neither buys anything. Buying, restoring and
replaying need a store sandbox account and, on Android, a build Play installed —
neither of which a simulator, an emulator without a Google account, or Maestro
can stand in for (docs/e2e.md, _subscriptions_). Use a disposable account, the
build pointed at an api whose store secrets and notification URLs are set
(docs/iap.md, _config per env_), and record the store account's role (sandbox
tester, license tester), never its address or password.

### App Store sandbox purchase

`IAP-APPLE-RELEASE-001` `release` `online` `ios`

On a real iPhone running an App Store-compatible build (TestFlight or a
distribution-signed build), signed into a Sandbox Apple Account under Settings →
Developer:

1. Settings → Subscription: the Plus card shows the storefront's price, not
   `$48/year`, and **Upgrade to Plus** is enabled.
2. Upgrade, and confirm the sheet offers the free trial. Subscribe. The section
   says **You're on Plus now — thank you.** with no polling pause, and the plan
   box reads Plus with **free trial**.
3. The api bound it: the `purchases` row is `appstore`, on this account's
   `user_id`, with the trial end as `expires_at`
   (`npm run replay:appstore -- --dry-run` lists the sandbox notifications for
   it).
4. **Replay after a failed verify.** With a second disposable account, stop the
   api (or cut the device's network) after confirming the sheet and before the
   app hears back. The section shows an error and stays Free. Restore the api,
   force-quit and relaunch, open Subscription and press **Refresh**: Plus, with
   no second purchase — the unfinished transaction replayed through verify.
5. **Manage subscription** opens the App Store's subscription settings for
   Bracemark. Cancel there; **Refresh** reads "Free trial ends on <date> — you
   won't be charged."

### Play license-tester purchase

`IAP-PLAY-RELEASE-001` `release` `online` `android`

On a real Android device signed into a license-tester Google account, with the
build installed from the internal test track (a sideloaded build is not the
build Play bills):

1. Settings → Subscription: the Plus card shows Play's price, not `$48/year`,
   and **Upgrade to Plus** is enabled. Open the sheet and back out of it: the
   card returns enabled with **no error** under it (`IAP-NATIVE-001`'s claim,
   which the emulator cannot reach).
2. Upgrade again and confirm Play selected the free-trial offer. Buy with the
   "always approves" test instrument. The plan box reads Plus with **free
   trial**.
3. The `purchases` row is `playstore`, on this account. Play Console → Order
   management shows the order **acknowledged** within minutes — the api's
   server-side acknowledge, not only the app's `finishTransaction`.
4. Let the compressed test trial convert (minutes for a license tester): after
   **Refresh**, the box reads "Renews on <date>", with no **free trial** tag —
   Play's trial tag must not outlive the trial (docs/iap.md, _the trial_).
5. **Manage subscription** opens Play's subscription screen for Bracemark.
   Cancel there and confirm the section's "it won't renew" wording after
   **Refresh**.

### Restore purchases

`IAP-RESTORE-001` `release` `online` `ios` `android`

Run on each platform after its purchase check above, while that store account
still holds the subscription:

1. Delete the app, reinstall, sign in to the SAME Bracemark account. It reads
   Plus already (the server holds the purchase); **Restore purchases** reports
   `Restored — you're on Plus.` and nothing changes.
2. Sign out and sign in to a DIFFERENT, free disposable Bracemark account on the
   same device and store account. **Restore purchases** must not move the
   subscription: the section shows the server's refusal (`purchase_bound`) and
   the plan stays Free. On the server the row's `user_id` is still the first
   account's.
3. Sign in to a store account that never bought: **Restore purchases** says
   `No purchases to restore on this store account.`

## Store review prompt

`REVIEW-PROMPT-RELEASE-001` `release` `online` `ios` `android`

Development builds never ask (`__DEV__`), so no Maestro run can reach this, and the
OS decides whether a sheet appears at all — which is what this checks. The rules
are `apps/bracemark-expo/src/lib/review-prompt.ts`; the platform behaviour is
docs/expo-dependencies.md, _expo-store-review_. Start each platform from a fresh
install so the device has never been asked.

1. **iOS.** From `apps/bracemark-expo`, build Release on the simulator —
   `npx expo run:ios --configuration Release` — and sign in to a disposable
   account. Save nine links from the add panel: no sheet. Save a tenth: the
   rating sheet rises about a second and a half after the panel closes, over the
   list rather than over the panel. Dismiss it.
2. **The window holds.** Save ten more: no sheet.
3. **An import never asks.** Delete the app, reinstall, sign in, and import a
   small HTML bookmarks file with no saves first: the receipt shows and no sheet
   follows. Then save nine links: still no sheet, because imported links are not
   saves. The tenth raises it.
4. **Share-sheet saves count, but don't ask.** Reinstall and sign in. Share nine
   links from Safari through the share sheet: no sheet, in Safari or on
   returning to the app. Save one from the add panel: the sheet rises.
5. **Never after a failure.** A save refused as a duplicate doesn't count toward
   the ten.
6. **The store page retires it.** Reinstall and sign in. In Settings → About,
   press **Rate Bracemark**: the App Store opens on Bracemark's review composer.
   Come back. Save ten links: no sheet.
7. **Android.** Upload the release build to Play's internal app sharing (or an
   internal testing track), install it from that link on a device signed in to
   a Google account that has not reviewed Bracemark, and repeat steps 1, 4 and 6.
   Play shows its in-app review card; a sideloaded build calls the same code and
   shows nothing, which is expected.
