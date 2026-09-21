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
