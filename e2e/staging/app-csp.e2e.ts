import { expect, test } from '../web/fixtures/app';
import { WEB_URL } from '../web/fixtures/env';

// The signed-in half of the deployed policy that no product journey asserts on.
// Both resources here are fetched by the BROWSER rather than by the app, so a
// policy that refused either would leave every journey green: the app works
// without its worker until the network goes, and without its manifest until
// somebody tries to install it. `worker-src 'self'` and `manifest-src 'self'`
// are the directives; the app fixture's own guard (../web/fixtures/csp.ts) fails
// the case on any violation along the way, Argon2's wasm and blob worker at
// account creation included.
test(
  'signed-in app activates its service worker and loads its manifest under the deployed CSP',
  {
    tag: ['@STAGING-CSP-004', '@smoke', '@online', '@security'],
  },
  async ({ page }) => {
    await page.goto('/links');
    // Registered by the app once the session is authenticated
    // (docs/offline-mode.md, _when the worker registers_).
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.state ?? null,
          ),
        { timeout: 60_000 },
      )
      .toBe('activated');

    // Chrome fetches a manifest only when something asks for it. This asks the
    // way its own installability check does, and reports what that check saw.
    const cdp = await page.context().newCDPSession(page);
    const manifest = await cdp.send('Page.getAppManifest');
    expect(manifest.url).toBe(`${WEB_URL}/manifest.json`);
    expect(manifest.errors).toEqual([]);
    expect(JSON.parse(manifest.data ?? 'null')).toMatchObject({ start_url: expect.any(String) });
  },
);
