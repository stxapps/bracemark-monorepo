/**
 * @jest-environment node
 */

// The iOS share extension's bundle request, as metro.config.js rewrites it
// (docs/share-sheet.md, _the share extension has almost no memory to spare_).
//
// A Debug build's share extension asks Metro for a dev bundle, and that bundle
// does not fit under the extension's 120 MB cap on an iPhone 12: the sheet was
// killed on its first render with no error anywhere. The config rewrites ONLY
// the share extension's requests (tagged `shareExtension=true` by
// expo-share-extension's controller) to a minified production bundle with no
// `transform.bytecode` — which would skip minification and serve 8 MB of text.
// Every way this breaks is silent until a device: a rewrite that stops matching
// serves the dev bundle again; one that matches too much serves the APP a
// production bundle (no LogBox, no Fast Refresh) in every dev session.
//
// The real config is loaded, wrappers and all, so a reorder of them (Uniwind
// replacing `server`, say) fails here.

type RewriteRequestUrl = (url: string) => string;

const ORIGINAL_ENV = process.env.BRACEMARK_SHARE_DEV_BUNDLE;

function loadRewrite(devBundle?: '1'): RewriteRequestUrl {
  if (devBundle) process.env.BRACEMARK_SHARE_DEV_BUNDLE = devBundle;
  else delete process.env.BRACEMARK_SHARE_DEV_BUNDLE;
  let rewrite: RewriteRequestUrl | undefined;
  jest.isolateModules(() => {
    rewrite = jest.requireActual<{ server: { rewriteRequestUrl: RewriteRequestUrl } }>(
      '../../../metro.config.js',
    ).server.rewriteRequestUrl;
  });
  if (!rewrite) throw new Error('metro.config.js exports no server.rewriteRequestUrl');
  return rewrite;
}

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.BRACEMARK_SHARE_DEV_BUNDLE;
  else process.env.BRACEMARK_SHARE_DEV_BUNDLE = ORIGINAL_ENV;
});

const params = (url: string) => new URL(url, 'http://localhost').searchParams;

// What the controller sends from a Debug build, in both shapes Metro hands the
// rewriter: a path, and a full URL.
const SHARE_PATH = '/index.bundle?platform=ios&dev=true&minify=false&shareExtension=true';
const SHARE_URL =
  'http://192.168.1.5:8081/index.bundle?platform=ios&dev=true&minify=false&shareExtension=true&transform.bytecode=1';
const APP_PATH = '/index.bundle?platform=ios&dev=true&minify=false&app=com.bracemark.app';

describe('a Debug build’s share extension', () => {
  const rewrite = loadRewrite();

  it('gets the share entry, as a minified production bundle', () => {
    const out = rewrite(SHARE_PATH);
    expect(out.startsWith('/index.share.bundle?')).toBe(true);
    expect(params(out).get('dev')).toBe('false');
    expect(params(out).get('minify')).toBe('true');
    expect(params(out).get('shareExtension')).toBe('true');
  });

  it('never gets a bytecode request, and is bundled for Hermes', () => {
    const out = rewrite(SHARE_URL);
    expect(params(out).has('transform.bytecode')).toBe(false);
    expect(params(out).get('transform.engine')).toBe('hermes');
  });

  // Metro passes either; the answer has to come back in the shape it came in.
  it('hands a full URL back as a full URL, on the same host', () => {
    const out = rewrite(SHARE_URL);
    expect(out.startsWith('http://192.168.1.5:8081/index.share.bundle?')).toBe(true);
  });
});

it('leaves the app’s own requests alone', () => {
  const rewrite = loadRewrite();
  expect(rewrite(APP_PATH)).toBe(APP_PATH);
});

// The simulator enforces no cap, so a developer can ask for the dev bundle back
// (LogBox, console relay) — and still never a bytecode one.
it('serves the share extension a dev bundle when BRACEMARK_SHARE_DEV_BUNDLE=1', () => {
  const rewrite = loadRewrite('1');
  const out = rewrite(SHARE_URL);
  expect(out).toContain('/index.share.bundle?');
  expect(params(out).get('dev')).toBe('true');
  expect(params(out).get('minify')).toBe('false');
  expect(params(out).has('transform.bytecode')).toBe(false);
});
