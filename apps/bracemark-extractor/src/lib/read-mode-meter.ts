// THE METER. Readability does some of its work again and again — an `<embed>`'s attributes once for
// every container above it (`_cleanConditionally`), an element's text once for every element above
// it, and all of it once per attempt, up to four when the article it finds is short — so no
// prediction from the tree's shape bounds it: each review found another path the walk
// (read-mode-limits.ts) could not see (a 19 KB page, inside the walk's cap, took 175 s in workerd).
// So the reads that work goes through are COUNTED while Readability and the walker run: every
// `attributes`, `childNodes` and `children` list linkedom builds (it builds each afresh, stepping
// over the list it returns), every `textContent` and `innerHTML` it assembles, every tag query's
// result — each by its length. Past MAX_READ_MODE_WORK the read throws, and the page is
// `not-an-article`. A clock can't do this: a Worker's clock doesn't move during synchronous work.
//
// The getters are linkedom's own, wrapped once on its shared prototypes, and count only while a
// read is metered (`meter` set): Readability runs synchronously, so nothing else runs inside a read.
// A getter Readability starts using in an upgrade is not counted until it is added here.
export const MAX_READ_MODE_WORK = 20_000_000;

class ReadModeOverBudget extends Error {}

let meter: { spent: number; budget: number } | null = null;
let meterInstalled = false;

// Charges the running read `units`, and stops it past its budget. Outside a read, nothing.
export function spend(units: number): void {
  if (meter === null) return;
  meter.spent += units;
  if (meter.spent > meter.budget) throw new ReadModeOverBudget();
}

// What one item of each read costs, in units of about one attribute-list entry (~22 ns on Node):
// measured per getter over the pages that lean on it — an `attributes` entry (an `<embed>`'s, 50
// containers deep: 22 ns), a `children` entry (flat siblings: ~37 ns), a character of `textContent`
// (a 1 MB article 40 deep, a 900 KB text run 240 deep: 0.5–1.2 ns) or of `innerHTML`, serialised
// node by node. So the items of a read are weighted to time, and a page can't buy a cheap unit.
//
// This table IS the list of what is wrapped: a read is metered exactly when it has a weight here.
const GETTER_WEIGHTS = {
  attributes: 1,
  childNodes: 2,
  children: 2,
  textContent: 1 / 32,
  innerHTML: 1 / 8,
} as const;
const METHOD_WEIGHTS = {
  getElementsByTagName: 1,
  querySelectorAll: 1,
} as const;

const lengthOf = (value: unknown): number =>
  value === null || value === undefined ? 0 : ((value as { length?: number }).length ?? 0);

function ownerOf(target: object, name: string): object {
  let proto: object | null = target;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) {
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  if (!proto) throw new Error(`linkedom has no ${name}`);
  return proto;
}

function meterGetter(target: object, name: string, weight: number): void {
  const proto = ownerOf(target, name);
  const descriptor = Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor;
  const get = descriptor.get as (this: unknown) => unknown;
  Object.defineProperty(proto, name, {
    ...descriptor,
    get(this: unknown) {
      const value = get.call(this);
      spend(1 + lengthOf(value) * weight);
      return value;
    },
  });
}

function meterMethod(target: object, name: string, weight: number): void {
  const proto = ownerOf(target, name) as Record<string, (...args: unknown[]) => unknown>;
  const method = proto[name];
  proto[name] = function (this: unknown, ...args: unknown[]) {
    const value = method.apply(this, args);
    spend(1 + lengthOf(value) * weight);
    return value;
  };
}

// Wraps linkedom's prototypes, once per isolate; `document` is any linkedom document, used only to
// reach them.
export function installMeter(document: { createElement(tagName: string): object }): void {
  if (meterInstalled) return;
  meterInstalled = true;
  const element = document.createElement('div');
  for (const [name, weight] of Object.entries(GETTER_WEIGHTS)) meterGetter(element, name, weight);
  for (const [name, weight] of Object.entries(METHOD_WEIGHTS)) meterMethod(element, name, weight);
  // The document's own `querySelectorAll`; its `getElementsByTagName` is the element's.
  if (ownerOf(document, 'querySelectorAll') !== ownerOf(element, 'querySelectorAll')) {
    meterMethod(document, 'querySelectorAll', METHOD_WEIGHTS.querySelectorAll);
  }
}

// Runs `read` with the meter on; the units it spent, and what it returned (undefined past `budget`).
export function metered<T>(budget: number, read: () => T): { spent: number; value: T | undefined } {
  const session = { spent: 0, budget };
  meter = session;
  try {
    const value = read();
    return { spent: session.spent, value };
  } catch (err) {
    if (err instanceof ReadModeOverBudget) return { spent: session.spent, value: undefined };
    throw err;
  } finally {
    meter = null;
  }
}
