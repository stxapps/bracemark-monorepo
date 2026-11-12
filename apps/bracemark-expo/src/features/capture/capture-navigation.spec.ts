import { isCaptureNavigationAllowed } from './capture-navigation';

// A page can point its links and redirects at anything. react-native-webview hands a URL outside
// the origin whitelist to `Linking.openURL`, so without this rule a saved page could open
// another app from the capture screen. The WebView whitelists everything and asks this instead.
describe('isCaptureNavigationAllowed', () => {
  it('lets a page load, and the frames a page builds for itself', () => {
    for (const url of [
      'https://example.com/a',
      'http://example.com/a',
      'HTTPS://EXAMPLE.COM/A',
      'about:blank',
      'about:srcdoc',
    ]) {
      expect(isCaptureNavigationAllowed(url, true)).toBe(true);
    }
  });

  it('refuses a navigation that would open another app, or leave the web', () => {
    for (const url of [
      'intent://scan/#Intent;scheme=zxing;end',
      'whatsapp://send?text=hi',
      'tel:+15555550100',
      'mailto:someone@example.com',
      'sms:+15555550100',
      'itms-apps://apps.apple.com/app/id1',
      'market://details?id=com.example',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'not a url',
      '',
    ]) {
      expect(isCaptureNavigationAllowed(url, true)).toBe(false);
      expect(isCaptureNavigationAllowed(url, false)).toBe(false);
    }
  });

  it('allows blob: and data: as frame content only, never as where the window goes', () => {
    expect(isCaptureNavigationAllowed('blob:https://example.com/1234', false)).toBe(true);
    expect(isCaptureNavigationAllowed('data:text/html,<p>x</p>', false)).toBe(true);
    expect(isCaptureNavigationAllowed('blob:https://example.com/1234', true)).toBe(false);
    expect(isCaptureNavigationAllowed('data:text/html,<p>x</p>', true)).toBe(false);
    expect(isCaptureNavigationAllowed('data:text/html,<p>x</p>', undefined)).toBe(false);
  });
});
