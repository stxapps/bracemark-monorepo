import { type Box, boxOf, findNodes, type HierarchyNode } from './hierarchy';
import { type CaseStepContext } from './native-run';
import { capture } from './process';

// Where the soft keyboard is, in the hierarchy's own units, or null when none is
// up — the other half of every "reachable above the keyboard" claim.
//
// iOS: the keyboard is in Maestro's tree as its host `inputView`, whose frame
// covers the keys AND the suggestion bar above them (measured on iOS 26.5:
// [0,539][402,874] with the predictions strip at 539–583).
//
// Android: the IME is its own window and not in the app's tree at all, so the
// frame comes from the window manager — `dumpsys window InputMethod` reports
// whether the window is visible and the touchable region it claims, which is
// the keyboard's rectangle in the same pixels Maestro's bounds use.
export async function keyboardFrame(
  context: CaseStepContext,
  root: HierarchyNode,
): Promise<Box | null> {
  if (context.platform === 'ios') {
    const [input] = findNodes(root, (attributes) => attributes['resource-id'] === 'inputView');
    if (!input) return null;
    const box = boxOf(input);
    return box.bottom > box.top ? box : null;
  }
  const dump = (
    await capture('adb', ['-s', context.deviceId, 'shell', 'dumpsys', 'window', 'InputMethod'])
  ).stdout;
  if (!/isVisible=true/.test(dump)) return null;
  const region = /touchable region=SkRegion\(\((\d+),(\d+),(\d+),(\d+)\)\)/.exec(dump);
  if (!region) throw new Error('the IME window is visible but reports no touchable region');
  const [left, top, right, bottom] = region.slice(1).map(Number);
  return { left, top, right, bottom };
}
