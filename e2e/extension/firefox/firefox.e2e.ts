import { expect, test } from '@playwright/test';

import { launchFirefox, stageProbe, startFixtureServer } from './fixture';

// The browser extension's title/image collector, as Firefox runs it. Firefox injects
// page-meta.js as a CONTENT SCRIPT, where the page's DOM objects arrive through Xray
// wrappers and behave unlike Chrome's or jsdom's: a spread of a URLSearchParams
// iterator threw there on every page, so every Firefox save arrived with no title
// or image while Chrome and every spec passed (docs/link-extraction-keep.md, _⚠ a page
// moved in place_). Only Firefox can show that, so this case runs the build Firefox
// ships against two pages: one read as it stands, one that moved in place and has to
// be read again from its own address, with its own cookies.
test(
  'the Firefox build’s page collector reads a page as it stands, and re-reads one that moved in place',
  { tag: ['@EXT-EXTRACT-003', '@full', '@extension'] },
  async () => {
    const testInfo = test.info();
    const build = process.env.E2E_FIREFOX_EXTENSION_BUILD;
    if (!build) {
      throw new Error('run this case through `npm run e2e:extension:firefox`');
    }
    const server = await startFixtureServer();
    const probe = await stageProbe(testInfo.outputPath('probe'), build, server.origin);
    const browser = await launchFirefox(testInfo.outputPath('profile'));
    try {
      testInfo.annotations.push({ type: 'firefox', description: browser.version });
      await browser.installTemporaryAddon(probe);
      const reports = await Promise.race([
        server.reports,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('the probe never reported')), 60_000),
        ),
      ]);
      const report = (scenario: string) => reports.find((entry) => entry.scenario === scenario);

      // As it stands: the head came with this address, so it is read as it is, and
      // nothing is fetched again.
      const still = report('as-it-stands');
      expect(still?.error).toBeUndefined();
      expect(still?.result).toEqual({
        href: `${server.origin}/article?id=still`,
        collected: {
          ogTitle: 'Still page',
          ogImage: `${server.origin}/still.jpg`,
          docTitle: 'Still page - Site',
        },
      });
      expect(server.requests.filter((request) => request.path.startsWith('/article'))).toHaveLength(
        1,
      );

      // Moved in place: the stale A tags are replaced by the server's answer for B,
      // fetched with the page's own cookie ("(signed in)" in the title says it was).
      const moved = report('moved-in-place');
      expect(moved?.error).toBeUndefined();
      expect(moved?.result).toEqual({
        href: `${server.origin}/watch?v=B`,
        collected: {
          ogTitle: 'Video B (signed in)',
          ogImage: `${server.origin}/B.jpg`,
          docTitle: 'Video B - Tube',
        },
      });
      const reread = server.requests.filter((request) => request.path === '/watch?v=B');
      expect(reread).toHaveLength(1);
      expect(reread[0].cookie).toContain('sid=e2e');
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
