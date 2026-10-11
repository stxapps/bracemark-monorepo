// The pictures a /docs page or /blog post may show: `<Figure name="…" />`
// (components/mdx-components.tsx). One record per picture — the files, the size,
// the alt text and the caption — so a page chooses only WHERE a picture goes and
// everything that can go wrong about it sits in a file ESLint and tsc read. MDX
// is read by neither.
//
// A FIGURE IS ONE SURFACE AT THE SIZE THE APP DRAWS IT, and that is the rule that
// decides what is worth a figure at all. A docs picture is read for its labels,
// and most readers of a "how do I…" page are on the phone they are holding: a
// 1280px capture of the whole app lands in a 358px column at a quarter of its
// size, where it shows that a screen exists and none of what it says. So each
// one here is a panel, a popup or a sheet — 320 to 402 CSS px wide — and
// `width`/`height` below are CSS pixels, which the page never exceeds. It is why
// these are not the landing page's figure: that one is a picture OF the library,
// set 1088px wide, and nobody is asked to read a row in it.
//
// The files are `public/figures/<name>-<width>.webp`, made by hand and committed
// (tools/scripts/make-image-variants.sh has why this is not a build step). The
// ladder is the CSS width times each pixel density the capture can feed — never
// the script's default 1100/1600/2200, which is the landing band's measure:
//
//   tools/scripts/make-image-variants.sh e2e/.artifacts/shot/search-advanced.png \
//     apps/bracemark-site/public/figures/advanced-search 320 640 960
//
// `figures.spec.ts` holds this list and that folder to each other, in both
// directions and down to each file's pixel size.
//
// ⚠ WHAT NOTHING HOLDS: the picture against the product. A capture of a panel
// that has since gained a field renders exactly as well as a current one, so
// each entry names the scene that takes it and re-taking is a decision someone
// makes when that screen changes shape (docs/brand-assets.md, _the generated
// pictures_ — the regenerate list). And the ALT TEXT against the picture: it
// describes the capture, state by state, so it is re-read every time one is
// re-taken.

export interface DocFigure {
  /** CSS px — the size the app draws this surface at, and the widest the page shows it. */
  width: number;
  height: number;
  /** The `-<width>.webp` variants on disk, narrowest first. */
  widths: number[];
  alt: string;
  /** What the picture cannot say about itself. Optional: most say enough. */
  caption?: string;
  /**
   * How the picture is edged, when the default is wrong for it. The default is a
   * hairline ring at the radius the app's panels, popups and cards have, which
   * also trims the four corners of page a capture framed on one brings with it.
   *
   * - `dialog` — the same ring at a dialog's larger radius. The corners behind a
   *   dialog are the dimmed app, so a radius one step short leaves four dark
   *   nicks.
   * - `own` — no ring at all: the capture is a row or a box cut out AT its own
   *   border, so that border is in the picture, and the corners outside it are
   *   the app's page colour, which is this site's.
   */
  edge?: 'dialog' | 'own';
}

export const FIGURES = {
  // `search-advanced` in e2e/shot/scenes.ts (`npm run shot:web -- search-advanced`),
  // which frames the panel itself. The scene's draft is what the alt text and
  // the caption read back, so the three move together.
  'advanced-search': {
    width: 320,
    height: 898,
    widths: [320, 640, 960],
    alt:
      'The Advanced search panel: six word fields — All of these words, Any of these words, ' +
      'None of these words, URL contains, Title contains, and Note contains — above a Lists ' +
      'checklist with one list ticked and one struck out, and a Tags checklist with two tags ' +
      'ticked and Match set to all. Clear and Search sit at the bottom.',
    caption:
      'Advanced search in the web app, with one list included, one excluded, and two tags ' +
      'that must both match.',
  },
  // `ext-save` in e2e/shot/extension.ts (`npm run shot:ext -- ext-save`): the
  // popup at its own 360px, DPR 2, so there is no 3x file to offer.
  'extension-save': {
    width: 360,
    height: 479,
    widths: [360, 720],
    alt:
      'The browser extension’s popup over a page that is not saved yet. Under Save this page ' +
      'are the page’s title and address, a List picker set to a nested list, a Tags picker ' +
      'holding two tags, an empty Note field, and a Save button. The last line reads Synced ' +
      'just now.',
    caption: 'The browser extension’s popup, with a list and two tags chosen before saving.',
  },
  // `mobile-ios-save-from-any-app` from `npm run shot:mobile -- ios`, on a
  // 402pt-wide iPhone, cut down to the sheet:
  //
  //   magick e2e/.artifacts/shot/mobile-ios-save-from-any-app.png \
  //     -crop 1206x1002+0+1620 +repage e2e/.artifacts/shot/share-screen.png
  //
  // 1620 is found, not chosen — the sheet's own top edge, the first row that is
  // white at the centre of the 1206x2622 capture — and it moves when the sheet
  // gains or loses a row. Everything above it is somebody else's: the page
  // being shared, dimmed, under iOS's own share card. A store picture keeps
  // that for context; here the masthead of the page would be the largest thing
  // in a figure about our four controls. The sheet's top corners are 16pt, the
  // radius `<Figure>` clips to, which is what makes cutting AT the edge clean.
  'share-screen': {
    width: 402,
    height: 334,
    widths: [402, 804, 1206],
    alt:
      'Bracemark’s share screen on an iPhone. Under the Bracemark name are the shared page’s ' +
      'title and address, a row showing the chosen list, a row showing three chosen tags, ' +
      'and a Save button.',
    caption:
      'The share screen on an iPhone, with a list and three tags chosen. Android shows the ' +
      'same choices.',
  },
  // `select-links` in e2e/shot/scenes.ts — the whole 390x420 viewport, the web
  // app at a phone's width. The caption names what the bar's icons are, because
  // at this width the bar does not.
  'select-links': {
    width: 390,
    height: 420,
    widths: [390, 780, 1170],
    alt:
      'The web app on a narrow screen with selection on. Under the My List title, a bar reads ' +
      '2 selected, with a close button and a select-all box before it and four icon buttons ' +
      'after it: copy, move, more actions, and remove. Every link has a tick box, and the ' +
      'first and third are ticked.',
    caption:
      'Selection in the web app on a narrow screen. Copy, Move to, and Remove stay on the ' +
      'bar; Edit tags, Pin, and Archive are under ⋯.',
  },
  // `sync-status` in e2e/shot/scenes.ts, framed on the row.
  'sync-status': {
    width: 343,
    height: 118,
    widths: [343, 686, 1029],
    edge: 'own',
    alt:
      'The Sync row in the web app’s settings: a tick, the line Last synced just now, a note ' +
      'that images download as links come into view, and a Sync now button.',
    caption: 'Sync status in the web app, under Settings → Data.',
  },
  // `import-over-limit` in e2e/shot/scenes.ts, framed on the question, on the
  // `free-full` dev account. ⚠ THE PICTURE PRINTS THE FREE PLAN'S LINK CAP —
  // the one number a page is otherwise never allowed to type (`<FreeLinks />`).
  // `figures.spec.ts` fails when the plan table stops agreeing with it; the alt
  // text says what the question says without repeating its numbers.
  'import-over-limit': {
    width: 343,
    height: 218,
    widths: [343, 686, 1029],
    edge: 'own',
    alt:
      'The import’s question about a file that does not fit. It gives the number of new links ' +
      'in the file, how many the plan holds, how many are already saved, and so how many ' +
      'there is room for, and says nothing has been imported yet. Three buttons follow: one ' +
      'to import the links that fit, Cancel, and See plans.',
    caption:
      'What the web app asks when a file holds more new links than a free account has room for.',
  },
  // `edit-link` in e2e/shot/scenes.ts, framed on the dialog, on the library's
  // first link — which has a fetched title and image and no title of its own,
  // the state the caption reads back. A link the owner has retitled shows black
  // type in that box and makes the caption wrong.
  'edit-link': {
    width: 358,
    height: 760,
    widths: [358, 716, 1074],
    edge: 'dialog',
    alt:
      'The Edit link dialog in the web app, with the link’s address under its heading. The ' +
      'Title box is empty and shows the page’s own title in grey, above a line that reads ' +
      'Leave blank to use the page’s own title. Below it are the link’s list, its tags, an ' +
      'empty Note box, and the image fetched from the page with a Choose image button, then ' +
      'Cancel and Save.',
    caption:
      'Edit link in the web app. The list, tags, and note are yours, and so is a title once ' +
      'you type one; the grey title and the image were fetched from the page.',
  },
  // `recovery-code` in e2e/shot/scenes.ts: the auth card and 16px of the page
  // round it, with nobody signed in. ⚠ THE CODE IN IT OPENS NOTHING — the scene
  // stops before either button that would create the account, and the caption
  // says so because a reader cannot tell. A capture of a FINISHED ceremony would
  // print a working door to an account; never swap one in.
  'recovery-code': {
    width: 373,
    height: 725,
    widths: [373, 746, 1119],
    alt:
      'Step 3 of 3 of creating an account in the web app, headed Recovery code. A box holds ' +
      'a long code in groups of five characters, with Regenerate and Copy under it, then a ' +
      'tick box that reads I’ve saved my recovery code somewhere safe. The Create account ' +
      'button is greyed out, and under it is Create account without a recovery code.',
    caption:
      'The recovery step in the web app. Create account stays greyed out until you tick the ' +
      'box. The code shown here is an example and opens no account.',
  },
} satisfies Record<string, DocFigure>;

/** The free plan's link cap as `import-over-limit` shows it. See that entry. */
export const IMPORT_FIGURE_FREE_LINKS = 200;

export type FigureName = keyof typeof FIGURES;

/** Where a figure's variants live, without the `-<width>.webp` suffix. */
export function figureStem(name: FigureName): string {
  return `/figures/${name}`;
}
