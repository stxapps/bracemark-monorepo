import { WEB_APP_URL } from '@/utils/web-app-url';

// The two Firefox-only fields this needs. @wxt-dev/browser's types are generated from
// Chrome's, which has no containers, so neither `Tab.cookieStoreId` nor the matching
// `tabs.create` option is declared there.
type ContainerTab = { cookieStoreId?: string };
type CreateProperties = Parameters<typeof browser.tabs.create>[0] & { cookieStoreId?: string };

// Opens a bracemark-web page in a new tab — in the same Firefox container as the tab
// the popup was opened over. The extension's session doesn't cross origins
// (docs/browser-extension.md, _opening bracemark-web_), so what the new tab lands on
// is decided by bracemark-web's session in THAT tab's cookie store. Without
// `cookieStoreId`, Firefox puts an extension-created tab in the default container,
// and a user signed in to bracemark-web inside "Personal" gets the sign-in page.
//
// Reading `cookieStoreId` needs no permission; creating a tab with it needs `cookies`
// (Firefox-only in wxt.config.ts). Chrome tabs have no `cookieStoreId`, and Chrome's
// `tabs.create` rejects an option it doesn't know — so it is passed only when present.
//
// The active tab is read at click time rather than threaded down from the popup's
// own `tabs.query`: Complete's revisit path is rendered with no tab at all.
export async function openWebApp(path: string): Promise<void> {
  const url = `${WEB_APP_URL}${path}`;
  const [active] = (await browser.tabs
    .query({ active: true, currentWindow: true })
    .catch(() => [])) as ContainerTab[];
  const cookieStoreId = active?.cookieStoreId;
  if (cookieStoreId) {
    const props: CreateProperties = { url, cookieStoreId };
    try {
      await browser.tabs.create(props);
      return;
    } catch {
      // The container can be gone by the time of the click (deleted, or containers
      // switched off) — a tab in the default container beats a button that does nothing.
    }
  }
  await browser.tabs.create({ url });
}
