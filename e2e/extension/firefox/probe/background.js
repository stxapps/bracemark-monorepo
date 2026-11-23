// The probe's whole job (firefox.e2e.ts, EXT-EXTRACT-003): open each fixture page the
// case serves, inject the browser extension's OWN built page-meta.js into it the way
// the background does (utils/capture.ts, `captureTitleImage`), and post what came
// back to the fixture server. It decides nothing; the spec asserts.
//
// `__FIXTURE_ORIGIN__` is replaced when the probe is staged (fixtures/firefox.ts).
const ORIGIN = '__FIXTURE_ORIGIN__';

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(tabId, predicate) {
  for (let i = 0; i < 100; i++) {
    const tab = await browser.tabs.get(tabId);
    if (predicate(tab)) return;
    await settle(100);
  }
  throw new Error(`tab never reached the expected state`);
}

async function collect(scenario, path, ready) {
  const report = { scenario };
  try {
    const tab = await browser.tabs.create({ url: ORIGIN + path });
    // A new tab is `about:blank`, and already `complete`, before it starts loading.
    await waitFor(tab.id, (t) => t.status === 'complete' && t.url.startsWith(ORIGIN) && ready(t));
    const [injection] = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['page-meta.js'],
    });
    report.result = injection.result ?? null;
    if (injection.error) report.error = String(injection.error);
    await browser.tabs.remove(tab.id);
  } catch (error) {
    report.error = String(error);
  }
  await fetch(ORIGIN + '/report', { method: 'POST', body: JSON.stringify(report) });
}

(async () => {
  await collect('as-it-stands', '/article?id=still', () => true);
  // The page moves itself to `v=B` a moment after load (fixtures/firefox.ts).
  await collect('moved-in-place', '/watch?v=A', (t) => t.url.endsWith('v=B'));
  await fetch(ORIGIN + '/report', { method: 'POST', body: JSON.stringify({ scenario: 'done' }) });
})();
