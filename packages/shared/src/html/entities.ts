// HTML character references → the characters they stand for. The step every raw-HTML
// parser owes its output, and the one the DOM does for free.
//
// WHY THIS EXISTS. `bracemark-extension` reads a page through the live DOM, where
// `document.title` and `getAttribute('content')` hand back DECODED text — so the
// extension never sees an entity and needs nothing here. The other two extracting
// clients parse markup themselves and get the RAW bytes: `bracemark-extractor`'s
// `HTMLRewriter` decodes neither `text()` chunks (a `<title>` is RCDATA) nor
// `getAttribute` (verified against the real runtime in `lib/html.spec.ts`), and
// bracemark-expo's regex scanner sees whatever was in the file. Skip this step and a
// personal blog with no og:title — most of them — stores
// `Kleppmann&rsquo;s blog` as its title, and an og:image whose query string is
// spelled `?w=1200&amp;h=630` is fetched with a literal `&amp;` in it.
//
// DECODE AT THE PARSE BOUNDARY, EXACTLY ONCE — never in `cleanTitle`, which is
// downstream of all three clients. A page whose title really does display `&amp;`
// writes `&amp;amp;`; the extension's DOM already collapsed that to `&amp;`, so a
// second decode in the shared normalizer would turn every client's title into `&`.
// The rule is the same one `select.ts` states for selection: parse per platform,
// agree afterwards.
//
// A SEMICOLON IS REQUIRED. HTML's own parser accepts a handful of legacy names
// without one (`&amp`, `&copy`), which we deliberately don't: an unencoded ampersand
// in a real title (`Ben & Jerry's`, `AT&T`) is far commoner than a page missing its
// semicolon, and matching those would corrupt titles that are currently correct.
// Names are case-SENSITIVE for the same reason the table can afford to be complete —
// `&Alpha;` and `&alpha;` are different characters.

// The windows-1252 characters at 0x80–0x9F, where it differs from latin-1: smart
// quotes, dashes, ellipsis — exactly what a real page title uses. Empty string marks
// the five unassigned slots.
//
// Two callers, one table. Here it backs the HTML spec's legacy numeric-reference
// remap (below); in `expo-react`'s `parse-html-head.ts` it backs the BYTE decode for
// a page served as `iso-8859-1`. Both exist because the same authors emit the same
// characters, and browsers resolve both the same way — a second copy could only drift.
export const CP1252_HIGH: readonly string[] = [
  '€',
  '',
  '‚',
  'ƒ',
  '„',
  '…',
  '†',
  '‡',
  'ˆ',
  '‰',
  'Š',
  '‹',
  'Œ',
  '',
  'Ž',
  '',
  '',
  '‘',
  '’',
  '“',
  '”',
  '•',
  '–',
  '—',
  '˜',
  '™',
  'š',
  '›',
  'œ',
  '',
  'ž',
  'Ÿ',
];

// Every named reference HTML 4 defined, as `name=codepoint` (hex) — latin-1, the
// typographic specials, then the symbol/Greek set. HTML5's table is ~2200 entries,
// almost all of them mathematical aliases (`&DoubleLongLeftRightArrow;`) that no page
// title has ever contained; this is the subset a real document actually uses, and it
// is small enough to carry into a Workers isolate and an app bundle without thinking
// about it. Generated and checked against the `he` package's table — if you add a
// name, verify its codepoint the same way rather than typing one from memory.
const NAMED_ENTITIES_SRC =
  // latin-1 (U+00A0–U+00FF)
  'nbsp=a0 iexcl=a1 cent=a2 pound=a3 curren=a4 yen=a5 brvbar=a6 sect=a7 uml=a8 copy=a9 ordf=aa ' +
  'laquo=ab not=ac shy=ad reg=ae macr=af deg=b0 plusmn=b1 sup2=b2 sup3=b3 acute=b4 micro=b5 ' +
  'para=b6 middot=b7 cedil=b8 sup1=b9 ordm=ba raquo=bb frac14=bc frac12=bd frac34=be iquest=bf ' +
  'Agrave=c0 Aacute=c1 Acirc=c2 Atilde=c3 Auml=c4 Aring=c5 AElig=c6 Ccedil=c7 Egrave=c8 ' +
  'Eacute=c9 Ecirc=ca Euml=cb Igrave=cc Iacute=cd Icirc=ce Iuml=cf ETH=d0 Ntilde=d1 Ograve=d2 ' +
  'Oacute=d3 Ocirc=d4 Otilde=d5 Ouml=d6 times=d7 Oslash=d8 Ugrave=d9 Uacute=da Ucirc=db Uuml=dc ' +
  'Yacute=dd THORN=de szlig=df agrave=e0 aacute=e1 acirc=e2 atilde=e3 auml=e4 aring=e5 aelig=e6 ' +
  'ccedil=e7 egrave=e8 eacute=e9 ecirc=ea euml=eb igrave=ec iacute=ed icirc=ee iuml=ef eth=f0 ' +
  'ntilde=f1 ograve=f2 oacute=f3 ocirc=f4 otilde=f5 ouml=f6 divide=f7 oslash=f8 ugrave=f9 ' +
  'uacute=fa ucirc=fb uuml=fc yacute=fd thorn=fe yuml=ff ' +
  // the predefined five and the typographic specials
  'quot=22 amp=26 apos=27 lt=3c gt=3e OElig=152 oelig=153 Scaron=160 scaron=161 Yuml=178 ' +
  'circ=2c6 tilde=2dc ensp=2002 emsp=2003 thinsp=2009 zwnj=200c zwj=200d lrm=200e rlm=200f ' +
  'ndash=2013 mdash=2014 lsquo=2018 rsquo=2019 sbquo=201a ldquo=201c rdquo=201d bdquo=201e ' +
  'dagger=2020 Dagger=2021 permil=2030 lsaquo=2039 rsaquo=203a euro=20ac ' +
  // symbols, arrows and Greek
  'fnof=192 Alpha=391 Beta=392 Gamma=393 Delta=394 Epsilon=395 Zeta=396 Eta=397 Theta=398 ' +
  'Iota=399 Kappa=39a Lambda=39b Mu=39c Nu=39d Xi=39e Omicron=39f Pi=3a0 Rho=3a1 Sigma=3a3 ' +
  'Tau=3a4 Upsilon=3a5 Phi=3a6 Chi=3a7 Psi=3a8 Omega=3a9 alpha=3b1 beta=3b2 gamma=3b3 delta=3b4 ' +
  'epsilon=3b5 zeta=3b6 eta=3b7 theta=3b8 iota=3b9 kappa=3ba lambda=3bb mu=3bc nu=3bd xi=3be ' +
  'omicron=3bf pi=3c0 rho=3c1 sigma=3c3 sigmaf=3c2 tau=3c4 upsilon=3c5 phi=3c6 chi=3c7 psi=3c8 ' +
  'omega=3c9 thetasym=3d1 upsih=3d2 piv=3d6 bull=2022 hellip=2026 prime=2032 Prime=2033 ' +
  'oline=203e frasl=2044 weierp=2118 image=2111 real=211c trade=2122 alefsym=2135 larr=2190 ' +
  'uarr=2191 rarr=2192 darr=2193 harr=2194 crarr=21b5 lArr=21d0 uArr=21d1 rArr=21d2 dArr=21d3 ' +
  'hArr=21d4 forall=2200 part=2202 exist=2203 empty=2205 nabla=2207 isin=2208 notin=2209 ' +
  'ni=220b prod=220f sum=2211 minus=2212 lowast=2217 radic=221a prop=221d infin=221e ang=2220 ' +
  'and=2227 or=2228 cap=2229 cup=222a int=222b there4=2234 sim=223c cong=2245 asymp=2248 ' +
  'ne=2260 equiv=2261 le=2264 ge=2265 sub=2282 sup=2283 nsub=2284 sube=2286 supe=2287 ' +
  'oplus=2295 otimes=2297 perp=22a5 sdot=22c5 lceil=2308 rceil=2309 lfloor=230a rfloor=230b ' +
  'lang=27e8 rang=27e9 loz=25ca spades=2660 clubs=2663 hearts=2665 diams=2666';

// Built once, on first decode. The source above is a string rather than 253 object
// properties so the table reads as data and stays diffable a line at a time.
let named: Map<string, string> | undefined;
function namedEntities(): Map<string, string> {
  if (!named) {
    named = new Map();
    for (const pair of NAMED_ENTITIES_SRC.split(' ')) {
      const eq = pair.indexOf('=');
      named.set(pair.slice(0, eq), String.fromCodePoint(parseInt(pair.slice(eq + 1), 16)));
    }
  }
  return named;
}

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

// A numeric reference's character, or undefined to leave the reference literal.
// The 0x80–0x9F remap is the HTML spec's own legacy rule, not a workaround: a CMS
// that wrote `&#146;` meant windows-1252's `’`, and every browser renders it that
// way — decoding it as U+0092 (an unprintable control) would be the wrong answer, not
// a stricter one. A zero, an out-of-range value or a lone surrogate is left literal
// rather than becoming U+FFFD (what the spec says a renderer should show): these
// values reach a stored title, and `&#0;` is more debuggable than a black diamond.
function numericChar(body: string): string | undefined {
  const hex = body[1] === 'x' || body[1] === 'X';
  const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return undefined;
  if (code >= 0xd800 && code <= 0xdfff) return undefined;
  if (code >= 0x80 && code <= 0x9f) {
    const remapped = CP1252_HIGH[code - 0x80];
    if (remapped !== '') return remapped;
  }
  return String.fromCodePoint(code);
}

// Decode every character reference in `text`, in ONE pass — the output is never
// re-scanned, so `&amp;lt;` yields the literal `&lt;` and not `<`, which is what the
// page said. An unknown name (`&DoubleLongLeftRightArrow;`) is left exactly as
// written: a stray `&hellip;` in a title is a cosmetic miss, a dropped title is not.
export function decodeHtmlEntities(text: string): string {
  // The scan is the cost, not the table — skip both when there's nothing to decode.
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === '#') return numericChar(body) ?? whole;
    return namedEntities().get(body) ?? whole;
  });
}
