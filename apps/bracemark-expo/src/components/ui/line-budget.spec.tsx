// This spec passes `className` to the kit, so it needs uniwind's prop
// augmentation, which tsconfig.spec.json leaves out (button.spec.tsx's header).
/// <reference types="uniwind/types" />

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as React from 'react';
import { render } from '@testing-library/react-native';
import ts from 'typescript';

import { cn } from '../../lib/utils';
import {
  checkRendered,
  formatViolation,
  lineHeight,
  parseBox,
  type Violation,
} from '../../testing/line-budget';
import { Button, type ButtonProps } from './button';
import { Input } from './input';
import { Tabs, TabsList, TabsTrigger } from './tabs';
import { Text } from './text';

// Every fixed-height box that holds text must hold it at the 1.3 font-scale cap
// — the arithmetic, its reasons and its limits are in testing/line-budget.ts.
// Three layers, because each of the three clips found so far hid from the one
// before it:
//
//   1. THE KIT, every size. Button's `py-2` inside its own `h-10` clipped every
//      default button one Dynamic Type step up.
//   2. EVERY CALL SITE of a kit control, parsed out of src/ and rendered
//      through the real component with its own literal props. The advanced-
//      search filter box was `<Input className="h-8 text-sm">` — correct in
//      isolation, clipping only against Input's base `py-1`, which no file
//      shows beside it.
//   3. EVERY SAME-FILE BOX: a `View`/`Pressable` that pins a height, against the
//      Text written inside it in the same JSX. Static — the classes are read
//      from the source, not rendered — so it stops at any other component.
//
// What it cannot see: a Text whose size is a runtime expression, a component
// between the box and its text (other than the kit, which layer 2 renders),
// and anything a line box does not describe — wrapping, flex shrink, a font
// that isn't Inter. Those are what the large-text visual checkpoints are for
// (docs/e2e.md, _visual checkpoints_).

const noop = () => undefined;

function violations(ui: React.ReactElement, where: string): Violation[] {
  return checkRendered(render(ui).toJSON(), where);
}

function expectClean(found: Violation[]) {
  expect(found.map(formatViolation)).toEqual([]);
}

// ─── 1. the kit ──────────────────────────────────────────────────────────────

// A Record, so a size added to Button without a row here fails the typecheck.
const BUTTON_SIZES: Record<NonNullable<ButtonProps['size']>, true> = {
  default: true,
  xs: true,
  sm: true,
  lg: true,
  icon: true,
  'icon-xs': true,
  'icon-sm': true,
  'icon-lg': true,
};

test.each(Object.keys(BUTTON_SIZES) as NonNullable<ButtonProps['size']>[])(
  'Button size=%s holds its label at the cap',
  (size) => {
    expectClean(
      violations(
        <Button size={size}>
          <Text>Label</Text>
        </Button>,
        `Button size=${size}`,
      ),
    );
  },
);

test('Input holds its text at the cap', () => {
  expectClean(violations(<Input value="Typography" />, 'Input'));
});

test('Tabs hold their labels at the cap', () => {
  expectClean(
    violations(
      <Tabs value="a" onValueChange={noop}>
        <TabsList>
          <TabsTrigger value="a">
            <Text>Sync</Text>
          </TabsTrigger>
        </TabsList>
      </Tabs>,
      'Tabs',
    ),
  );
});

// The three clips this exists for, spelled as they shipped: the check has to
// FAIL on each, or a green run above means nothing.
describe('the specimens it was built on still fail', () => {
  test('the filter box: `h-8 text-sm` against Input’s `py-1`', () => {
    expect(violations(<Input className="h-8 py-1 text-sm" />, 'filter box')).toHaveLength(1);
  });

  test('the tab strip: a pinned `h-9` over the trigger’s `border py-1`', () => {
    expect(
      violations(
        <Tabs value="a" onValueChange={noop}>
          <TabsList className="h-9">
            <TabsTrigger value="a">
              <Text>Sync</Text>
            </TabsTrigger>
          </TabsList>
        </Tabs>,
        'tab strip',
      ),
    ).toHaveLength(1);
  });

  test('the button: `py-2` inside `h-10`', () => {
    expect(
      violations(
        <Button className="py-2">
          <Text>Label</Text>
        </Button>,
        'button',
      ),
    ).toHaveLength(1);
  });
});

// ─── reading the source ──────────────────────────────────────────────────────

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : sourceFiles(full);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.spec.tsx') ? [full] : [];
  });
}

type JsxNode = ts.JsxElement | ts.JsxSelfClosingElement;

interface Element {
  where: string;
  tag: string;
  attrs: ts.JsxAttributes;
  node: JsxNode;
}

function elements(): Element[] {
  return sourceFiles(SRC).flatMap((file) => {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const found: Element[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const { line } = source.getLineAndCharacterOfPosition(opening.getStart());
        found.push({
          where: `${path.relative(SRC, file)}:${line + 1}`,
          tag: opening.tagName.getText(),
          attrs: opening.attributes,
          node,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

function attribute(attrs: ts.JsxAttributes, name: string): ts.JsxAttribute | undefined {
  return attrs.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

// Every literal a className expression could contribute — `cn(...)`'s
// arguments, both arms of a ternary, the right side of `&&` — merged the way
// `cn` merges them. Both arms at once is deliberately the worst case. A
// `Platform.select` arm keyed `web` is left out: it never reaches a phone.
function literalClasses(expression: ts.Node): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    return [expression.head.text, ...expression.templateSpans.map((s) => s.literal.text)];
  }
  if (ts.isPropertyAssignment(expression) && expression.name.getText() === 'web') return [];
  const found: string[] = [];
  ts.forEachChild(expression, (child) => {
    found.push(...literalClasses(child));
  });
  return found;
}

function staticString(attrs: ts.JsxAttributes, name: string): string | undefined {
  const init = attribute(attrs, name)?.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression) {
    const parts = literalClasses(init.expression);
    return parts.length ? cn(...parts) : undefined;
  }
  return undefined;
}

// The JSX elements rendered as this element's children — through fragments,
// `{cond && <…/>}`, ternaries and `.map(…)` bodies, but not into another
// element's own children.
function childElements(node: JsxNode): JsxNode[] {
  if (ts.isJsxSelfClosingElement(node)) return [];
  const found: JsxNode[] = [];
  const collect = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      found.push(n);
      return;
    }
    ts.forEachChild(n, collect);
  };
  node.children.forEach(collect);
  return found;
}

function tagOf(node: JsxNode): string {
  return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText();
}

function attrsOf(node: JsxNode): ts.JsxAttributes {
  return (ts.isJsxElement(node) ? node.openingElement : node).attributes;
}

// The first Text written inside a control, however deep in plain JSX.
function firstText(node: JsxNode): JsxNode | undefined {
  for (const child of childElements(node)) {
    if (tagOf(child) === 'Text') return child;
    const nested = firstText(child);
    if (nested) return nested;
  }
  return undefined;
}

const ELEMENTS = elements();

// ─── 2. every call site of a kit control ─────────────────────────────────────

function renderCallSite(el: Element): React.ReactElement | undefined {
  const className = staticString(el.attrs, 'className');
  const label = firstText(el.node);
  const labelClass = label ? staticString(attrsOf(label), 'className') : undefined;
  const text = <Text className={labelClass}>Label</Text>;
  switch (el.tag) {
    case 'Button': {
      // An icon-only button has no line to clip. `asChild` hands the box to
      // its child, which the same-file pass reads instead.
      if (!label || attribute(el.attrs, 'asChild')) return undefined;
      const size = staticString(el.attrs, 'size') as ButtonProps['size'];
      return (
        <Button size={size} className={className}>
          {text}
        </Button>
      );
    }
    case 'Input':
      return <Input className={className} value="Typography" />;
    case 'TabsList':
      return (
        <Tabs value="a" onValueChange={noop}>
          <TabsList className={className}>
            <TabsTrigger value="a">
              <Text>Label</Text>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      );
    case 'TabsTrigger':
      return (
        <Tabs value="a" onValueChange={noop}>
          <TabsList>
            <TabsTrigger value="a" className={className}>
              {text}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      );
    default:
      return undefined;
  }
}

test('every kit control call site holds its text at the cap', () => {
  const sites = ELEMENTS.flatMap((el) => {
    const ui = renderCallSite(el);
    return ui ? [{ el, ui }] : [];
  });
  // A scan that silently matched nothing would pass forever.
  expect(sites.length).toBeGreaterThan(50);
  expectClean(sites.flatMap(({ el, ui }) => violations(ui, el.where)));
});

// ─── 3. every same-file pinned box ───────────────────────────────────────────

const HOSTS = new Set(['View', 'Pressable']);

// What ui/text.tsx puts on every Text before the call site's classes.
const TEXT_BASE = 'font-sans text-foreground text-base';

function checkStatic(node: JsxNode, room: number, where: string, found: Violation[]) {
  for (const child of childElements(node)) {
    const tag = tagOf(child);
    const className = staticString(attrsOf(child), 'className') ?? '';
    const box = parseBox(className);
    if (box.hidden || box.outOfFlow) continue;
    if (tag === 'Text') {
      const merged = cn(TEXT_BASE, className);
      const needs = lineHeight(merged) * 1.3;
      if (needs > room + 0.01) found.push({ where, className: merged, room, needs });
    } else if (HOSTS.has(tag) && box.height === undefined) {
      checkStatic(child, room - box.inset, where, found);
    }
    // A host that pins its own height is checked as its own box; any other
    // component is opaque here (the kit is rendered in layer 2).
  }
}

test('every View/Pressable that pins a height holds the Text written inside it', () => {
  const found: Violation[] = [];
  let boxes = 0;
  for (const el of ELEMENTS) {
    if (!HOSTS.has(el.tag)) continue;
    const box = parseBox(staticString(el.attrs, 'className') ?? '');
    if (box.height === undefined) continue;
    boxes++;
    checkStatic(el.node, box.height - box.inset, el.where, found);
  }
  expect(boxes).toBeGreaterThan(10);
  expectClean(found);
});
