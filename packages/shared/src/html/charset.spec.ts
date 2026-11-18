import { declaredCharset, decodeCp1252, isWindows1252Label, WINDOWS_1252_LABELS } from './charset';

// The charset sniff both raw-HTML readers share (charset.ts's header): bracemark-extractor's
// read mode and bracemark-expo's head scanner each had their own until they had drifted —
// different header patterns, a 1 KB vs a 2 KB meta window, one lowercasing and one not —
// so the same page could be declared one charset on the server and another on the phone.

const ascii = (text: string) => new TextEncoder().encode(text);

describe('declaredCharset', () => {
  it('lets the header win over the document', () => {
    const page = ascii('<meta charset="windows-1252"><title>x</title>');
    expect(declaredCharset(page, 'text/html; charset=utf-8')).toBe('utf-8');
    expect(declaredCharset(page, 'text/html')).toBe('windows-1252');
  });

  it('reads both meta spellings, quoted or not', () => {
    expect(declaredCharset(ascii('<meta charset=Shift_JIS>'), null)).toBe('shift_jis');
    expect(declaredCharset(ascii("<meta charset='euc-kr' />"), null)).toBe('euc-kr');
    expect(
      declaredCharset(
        ascii('<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">'),
        undefined,
      ),
    ).toBe('iso-8859-1');
  });

  // Lowercased, so a caller comparing labels (expo's windows-1252 check) can't miss
  // `ISO-8859-1` and decode a latin-1 page as UTF-8.
  it('lowercases the label from either source', () => {
    expect(declaredCharset(ascii(''), 'text/html; Charset="ISO-8859-1"')).toBe('iso-8859-1');
    expect(declaredCharset(ascii('<META CHARSET="UTF-8">'), null)).toBe('utf-8');
  });

  // `[\w-]+` stopped at the `:` and the `.`, handing the decoder a label that names
  // nothing — so the page decoded as UTF-8 instead of the windows-1252 it declared.
  it('keeps a whole WHATWG label, punctuation included', () => {
    expect(declaredCharset(ascii(''), 'text/html; charset=iso_8859-1:1987')).toBe(
      'iso_8859-1:1987',
    );
    expect(declaredCharset(ascii('<meta charset="ANSI_X3.4-1968">'), null)).toBe('ansi_x3.4-1968');
  });

  it('reads `charset` only as a parameter of the header, not inside the media type', () => {
    expect(declaredCharset(ascii(''), 'text/x-charset=koi8-r')).toBeUndefined();
  });

  // HTML's prescan length, written out rather than read from the constant: a spec that
  // measured against CHARSET_PRESCAN_BYTES would pass whatever window it was set to.
  it('looks for the meta declaration in the first 1024 bytes only, as a browser does', () => {
    const meta = '<meta charset="windows-1252">';
    const at = (offset: number) => ascii(`${' '.repeat(offset)}${meta}`);
    expect(declaredCharset(at(1024 - meta.length), null)).toBe('windows-1252');
    // One that starts past the window is never seen — under the old 2 KB window it was.
    expect(declaredCharset(at(1024), null)).toBeUndefined();
  });

  it('answers undefined when nothing is declared', () => {
    expect(declaredCharset(ascii('<title>x</title>'), 'text/html')).toBeUndefined();
    expect(declaredCharset(new Uint8Array(), null)).toBeUndefined();
  });
});

describe('decodeCp1252', () => {
  // 0x92 is a right single quote in windows-1252 and a C1 control in latin-1: the byte
  // that makes this decoder worth having on a runtime whose TextDecoder can't.
  it('maps the 0x80–0x9F range as windows-1252, the rest as latin-1', () => {
    expect(decodeCp1252(new Uint8Array([0x49, 0x74, 0x92, 0x73, 0x20, 0xe9]))).toBe('It’s é');
  });

  // The unassigned slots (0x81, 0x8D, …) included: they stay their latin-1 code points.
  it("matches a full TextDecoder's windows-1252 over every byte", () => {
    const every = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(decodeCp1252(every)).toBe(new TextDecoder('windows-1252').decode(every));
  });
});

describe('isWindows1252Label', () => {
  // Every label it accepts must be one a full decoder resolves to windows-1252 —
  // otherwise expo would decode some other encoding's page through the cp1252 table.
  it('accepts exactly the labels a full TextDecoder calls windows-1252', () => {
    expect(WINDOWS_1252_LABELS.size).toBeGreaterThan(0);
    for (const label of WINDOWS_1252_LABELS) {
      expect(isWindows1252Label(label)).toBe(true);
      expect(new TextDecoder(label).encoding).toBe('windows-1252');
    }
    for (const label of ['utf-8', 'iso-8859-2', 'iso-8859-15', 'shift_jis', 'windows-1251']) {
      expect(isWindows1252Label(label)).toBe(false);
    }
  });
});
