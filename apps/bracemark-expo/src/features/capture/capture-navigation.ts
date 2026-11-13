// Where the capture WebView may go. It loads a saved link's page, which is a stranger's,
// and the page chooses what its links and redirects point at.
//
// react-native-webview's own default is the reason this file exists: a request whose URL
// is outside `originWhitelist` (by default anything but http(s) and about:blank) is not
// blocked, it is handed to `Linking.openURL`. So a page that navigates to `intent://`, an
// app's deep link, `tel:`, `mailto:` or `sms:` opens another app on the user's phone, from
// a screen whose only job is to copy the page. The WebView therefore whitelists every
// origin (so nothing reaches `Linking`) and decides here, in `onShouldStartLoadWithRequest`,
// where a refusal is just a refusal.
//
// What is allowed: a page (http, https) and `about:` (blank, srcdoc, the frames a page
// builds for itself). `blob:` and `data:` are frame content a page builds, never a place to
// navigate the window to: allowed only for a sub-frame (iOS reports it; Android reports every
// request as top-frame). Everything else is refused, `file:` included. That rests on the
// library's `isTopFrame`, which iOS computes by comparing URLs: a `target="_blank"` link to such
// an address may count as a sub-frame there. Not observed on a device.
export function isCaptureNavigationAllowed(url: string, isTopFrame: boolean | undefined): boolean {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https' || scheme === 'about') return true;
  if (scheme === 'blob' || scheme === 'data') return isTopFrame === false;
  return false;
}
