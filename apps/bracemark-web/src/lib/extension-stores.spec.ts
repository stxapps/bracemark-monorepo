import { APP_STORE_URL, CHROME_WEB_STORE_URL, FIREFOX_ADDONS_URL } from '@stxapps/shared';

import { extensionStoreUrl } from './extension-stores';

// Which store the links page's previews prompt offers. Each miss is silent: Chrome's
// UA says "Safari", iPadOS Safari says "Macintosh", and a wrong answer only shows
// as a button that opens a store this browser can't install from.

const UA = {
  chrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:133.0) Gecko/133.0 Firefox/133.0',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

function as(userAgent: string, maxTouchPoints = 0) {
  jest.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

afterEach(() => jest.restoreAllMocks());

describe('extensionStoreUrl', () => {
  it.each([
    ['Chrome', UA.chrome, CHROME_WEB_STORE_URL],
    ['Edge, from the Chrome Web Store', UA.edge, CHROME_WEB_STORE_URL],
    ['Firefox', UA.firefox, FIREFOX_ADDONS_URL],
    ['Safari on a Mac, from the App Store', UA.safariMac, APP_STORE_URL],
  ])('%s', (_name, ua, url) => {
    as(ua);
    expect(extensionStoreUrl()).toBe(url);
  });

  it.each([
    ['Safari on an iPhone', UA.safariIphone],
    ['Chrome on Android', UA.chromeAndroid],
    ['Firefox on Android', UA.firefoxAndroid],
    ['an Android tablet', UA.androidTablet],
  ])('offers nothing on %s', (_name, ua) => {
    as(ua, 5);
    expect(extensionStoreUrl()).toBeNull();
  });

  it('offers nothing on an iPad, whose Safari says "Macintosh"', () => {
    as(UA.safariMac, 5);
    expect(extensionStoreUrl()).toBeNull();
  });
});
