import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { pemToPkcs8 } from './jwt';

// pemToPkcs8 is where a store secret's SHAPE meets the Workers runtime's strict
// `atob`, and it only runs on the first store call — a purchase the store has
// already taken. So the shapes a PEM can arrive in are pinned here, against the
// real runtime (Node's lenient base64 decoder would pass all of them, and pass
// a wrong one as garbage bytes).
//
// The key is the test pool's throwaway P-256 key (vitest.config.ts), exported
// by Node as a normal multi-line PEM; the other shapes are derived from it, so
// each case is a relation — same bytes as the multi-line form — not a fixture.

const multiLine = env.APPSTORE_PRIVATE_KEY;

function importsAsSigningKey(der: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
}

describe('pemToPkcs8', () => {
  it('decodes a multi-line PEM to a key WebCrypto imports', async () => {
    // The positive control: the fixture really is line-broken, and the bytes
    // really are a key — otherwise the equalities below compare garbage.
    expect(multiLine.trim().split('\n').length).toBeGreaterThan(2);
    await expect(importsAsSigningKey(pemToPkcs8(multiLine))).resolves.toBeDefined();
  });

  it('decodes a PEM flattened to one line — the keychain shape', () => {
    const flattened = multiLine.replace(/\n/g, '');
    expect(pemToPkcs8(flattened)).toEqual(pemToPkcs8(multiLine));
  });

  it('decodes a PEM whose line breaks are ESCAPED, not real', () => {
    // The shape inside a service-account JSON or a double-quoted dotenv line,
    // handed over unparsed. Without the escape handling this throws
    // InvalidCharacterError out of atob — a 502 on iap/verify.
    const escaped = multiLine.replace(/\n/g, '\\n');
    expect(escaped).not.toContain('\n');
    expect(pemToPkcs8(escaped)).toEqual(pemToPkcs8(multiLine));

    const escapedCrlf = multiLine.replace(/\n/g, '\\r\\n');
    expect(pemToPkcs8(escapedCrlf)).toEqual(pemToPkcs8(multiLine));
  });
});
