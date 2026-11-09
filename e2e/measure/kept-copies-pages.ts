// The real pages `measure:kept-copies` captures (kept-copies.ts). Public pages
// only, each loaded once per run, the way a person opening it would.
//
// The mix is the point, not any one page. A kept copy's size depends on what the
// page IS: read mode is only taken from an article, and the screenshot is the copy
// for everything that isn't one (docs/link-extraction-keep.md, _why these three_).
// So the list spans both, in roughly the proportion a library saves them, and
// `kind` records what the page was chosen as. What Readability actually decides is
// recorded beside it, from the run.
//
// A page that has moved or refuses a headless browser is reported as failed and
// left out of the figures. Replace it rather than retrying it.

export type PageKind = 'article' | 'page';

export interface MeasuredPage {
  url: string;
  kind: PageKind;
  // What sort of site it is, for reading the results — not used by the run.
  what: string;
}

export const KEPT_COPY_PAGES: readonly MeasuredPage[] = [
  // --- articles: reference ---------------------------------------------------
  {
    url: 'https://en.wikipedia.org/wiki/Bookmark_(digital)',
    kind: 'article',
    what: 'encyclopedia',
  },
  {
    url: 'https://en.wikipedia.org/wiki/Public-key_cryptography',
    kind: 'article',
    what: 'encyclopedia',
  },
  { url: 'https://en.wikipedia.org/wiki/Photosynthesis', kind: 'article', what: 'encyclopedia' },
  { url: 'https://en.wikipedia.org/wiki/Tokyo', kind: 'article', what: 'encyclopedia' },
  {
    url: 'https://en.wikipedia.org/wiki/World_War_II',
    kind: 'article',
    what: 'encyclopedia, very long',
  },
  {
    url: 'https://plato.stanford.edu/entries/consciousness/',
    kind: 'article',
    what: 'encyclopedia, very long',
  },
  {
    url: 'https://www.who.int/news-room/fact-sheets/detail/malaria',
    kind: 'article',
    what: 'fact sheet',
  },
  { url: 'https://www.gov.uk/apply-renew-passport', kind: 'article', what: 'government guide' },
  { url: 'https://arxiv.org/abs/1706.03762', kind: 'article', what: 'paper abstract' },
  {
    url: 'https://www.gutenberg.org/files/1342/1342-h/1342-h.htm',
    kind: 'article',
    what: 'whole book',
  },

  // --- articles: essays and blogs --------------------------------------------
  { url: 'https://www.paulgraham.com/greatwork.html', kind: 'article', what: 'essay' },
  { url: 'https://www.paulgraham.com/avg.html', kind: 'article', what: 'essay' },
  {
    url: 'https://martinfowler.com/articles/microservices.html',
    kind: 'article',
    what: 'long article',
  },
  { url: 'https://martinfowler.com/bliki/TwoHardThings.html', kind: 'article', what: 'short post' },
  {
    url: 'https://www.joelonsoftware.com/2000/08/09/the-joel-test-12-steps-to-better-code/',
    kind: 'article',
    what: 'blog',
  },
  {
    url: 'https://blog.codinghorror.com/the-best-code-is-no-code-at-all/',
    kind: 'article',
    what: 'blog',
  },
  {
    url: 'https://overreacted.io/a-complete-guide-to-useeffect/',
    kind: 'article',
    what: 'blog, long',
  },
  {
    url: 'https://jvns.ca/blog/2023/02/08/why-does-0-1-plus-0-2-equal-0-30000000000000004/',
    kind: 'article',
    what: 'blog',
  },
  {
    url: 'https://simonwillison.net/2024/Dec/31/llms-in-2024/',
    kind: 'article',
    what: 'blog, long',
  },
  { url: 'https://danluu.com/input-lag/', kind: 'article', what: 'blog, tables' },
  { url: 'https://blog.cloudflare.com/the-road-to-quic/', kind: 'article', what: 'company blog' },
  {
    url: 'https://www.cloudflare.com/learning/ddos/what-is-a-ddos-attack/',
    kind: 'article',
    what: 'explainer',
  },
  {
    url: 'https://css-tricks.com/snippets/css/a-guide-to-flexbox/',
    kind: 'article',
    what: 'tutorial, images',
  },
  { url: 'https://web.dev/articles/vitals', kind: 'article', what: 'tutorial' },

  // --- articles: news and magazines ------------------------------------------
  {
    url: 'https://www.theguardian.com/news/2018/mar/17/cambridge-analytica-facebook-influence-us-election',
    kind: 'article',
    what: 'news, long',
  },
  {
    url: 'https://www.seriouseats.com/the-food-lab-best-chocolate-chip-cookie-recipe',
    kind: 'article',
    what: 'recipe, long',
  },
  {
    url: 'https://www.allrecipes.com/recipe/10813/best-chocolate-chip-cookies/',
    kind: 'article',
    what: 'recipe',
  },

  // --- articles: documentation -----------------------------------------------
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching',
    kind: 'article',
    what: 'docs',
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures',
    kind: 'article',
    what: 'docs',
  },
  { url: 'https://docs.python.org/3/tutorial/classes.html', kind: 'article', what: 'docs' },
  {
    url: 'https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html',
    kind: 'article',
    what: 'docs, code',
  },
  { url: 'https://react.dev/learn/thinking-in-react', kind: 'article', what: 'docs, code' },
  { url: 'https://go.dev/doc/effective_go', kind: 'article', what: 'docs, very long' },
  {
    url: 'https://www.postgresql.org/docs/current/tutorial-join.html',
    kind: 'article',
    what: 'docs',
  },
  { url: 'https://kubernetes.io/docs/concepts/overview/', kind: 'article', what: 'docs' },
  {
    url: 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array',
    kind: 'article',
    what: 'Q&A',
  },

  // --- pages: front pages and feeds ------------------------------------------
  { url: 'https://en.wikipedia.org/wiki/Main_Page', kind: 'page', what: 'front page' },
  { url: 'https://www.bbc.com/news', kind: 'page', what: 'news front page' },
  { url: 'https://www.theguardian.com/international', kind: 'page', what: 'news front page' },
  { url: 'https://www.nytimes.com/', kind: 'page', what: 'news front page' },
  { url: 'https://www.economist.com/', kind: 'page', what: 'news front page' },
  { url: 'https://www.espn.com/', kind: 'page', what: 'sports front page' },
  { url: 'https://weather.com/', kind: 'page', what: 'weather' },
  { url: 'https://news.ycombinator.com/', kind: 'page', what: 'link list' },
  { url: 'https://www.reddit.com/r/programming/', kind: 'page', what: 'feed' },
  { url: 'https://github.com/facebook/react', kind: 'page', what: 'repository' },

  // --- pages: products, listings, media --------------------------------------
  { url: 'https://www.apple.com/macbook-air/', kind: 'page', what: 'product, photographic' },
  { url: 'https://www.apple.com/iphone/', kind: 'page', what: 'product, photographic' },
  {
    url: 'https://www.ikea.com/us/en/p/billy-bookcase-white-00263850/',
    kind: 'page',
    what: 'product',
  },
  { url: 'https://store.steampowered.com/app/620/Portal_2/', kind: 'page', what: 'product, dark' },
  { url: 'https://www.imdb.com/title/tt0111161/', kind: 'page', what: 'listing' },
  { url: 'https://www.goodreads.com/book/show/5907.The_Hobbit', kind: 'page', what: 'listing' },
  { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', kind: 'page', what: 'video' },
  { url: 'https://www.etsy.com/', kind: 'page', what: 'shop front page' },

  // --- pages: apps and landing pages -----------------------------------------
  { url: 'https://www.airbnb.com/', kind: 'page', what: 'app' },
  { url: 'https://www.booking.com/', kind: 'page', what: 'app' },
  { url: 'https://github.com/', kind: 'page', what: 'landing' },
  { url: 'https://stripe.com/', kind: 'page', what: 'landing, animated' },
  { url: 'https://linear.app/', kind: 'page', what: 'landing, dark' },
  { url: 'https://www.figma.com/', kind: 'page', what: 'landing' },
  { url: 'https://www.notion.com/', kind: 'page', what: 'landing' },
  { url: 'https://www.spotify.com/', kind: 'page', what: 'landing' },
];
