import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import { openWebApp } from './open-web-app';

// Where a bracemark-web tab opened from the popup lands. The page it shows depends on
// bracemark-web's session in the new tab's cookie store, so in Firefox the tab has to
// open in the container the user is browsing in. Get it wrong and nothing fails: the
// tab opens, it just opens on the sign-in page.

let fake: FakeBrowser;

beforeEach(() => {
  fake = installFakeBrowser();
});

const URL_ = 'http://localhost:3000/links';

it('opens in the container of the tab under the popup (Firefox)', async () => {
  fake.tabs.query.mockResolvedValue([{ id: 1, cookieStoreId: 'firefox-container-3' }]);

  await openWebApp('/links');

  expect(fake.tabs.create).toHaveBeenCalledTimes(1);
  expect(fake.tabs.create).toHaveBeenCalledWith({
    url: URL_,
    cookieStoreId: 'firefox-container-3',
  });
});

it('passes no cookieStoreId when the tab has none — Chrome rejects the option', async () => {
  fake.tabs.query.mockResolvedValue([{ id: 1 }]);

  await openWebApp('/links');

  expect(fake.tabs.create).toHaveBeenCalledWith({ url: URL_ });
});

it('still opens a tab when the active tab cannot be read', async () => {
  fake.tabs.query.mockRejectedValue(new Error('no permission'));

  await openWebApp('/links');

  expect(fake.tabs.create).toHaveBeenCalledWith({ url: URL_ });
});

it('falls back to the default container when that container is gone', async () => {
  // Deleted between the popup opening and the click, or containers switched off.
  fake.tabs.query.mockResolvedValue([{ id: 1, cookieStoreId: 'firefox-container-9' }]);
  fake.tabs.create.mockRejectedValueOnce(new Error('No cookie store exists'));

  await openWebApp('/links');

  expect(fake.tabs.create).toHaveBeenCalledTimes(2);
  expect(fake.tabs.create).toHaveBeenLastCalledWith({ url: URL_ });
});
