import { type LayoutChangeEvent, View } from 'react-native';

import { Text } from '../ui/text';

// A labeled field row in the two link editors (features/links/link-add-panel.tsx,
// link-edit-screen.tsx) — the native cousin of the `<Label density="dense">` over
// a control in a `flex-col gap-1.5` that web's link-add-surface and
// link-edit-dialog draw, and the one place the dense label tier
// (`text-xs text-muted-foreground`) is stated for both, as web-ui's label.tsx
// states it once for web. NOT a port of web-ui's `ui/field.tsx`, hence the name
// and the folder: that kit has no native twin (docs/theme.md, _the two kits_),
// and web's link editors don't use it either. Other surfaces keep their own
// tiers — the advanced-search WordField is `gap-1`, the settings TimeField's
// label is `text-sm font-medium`.
//
// The label names NOTHING for a screen reader: RN has no `<label for>`, and the
// children are arbitrary (an Input, a ListSelect, an image slot), so each control
// carries its own `aria-label` at the call site (docs/accessibility.md, _naming
// things that have no visible label_).
//
// `onLayout` is the edit screen's: its `focus` param scrolls to the field's
// content-relative `layout.y`, which needs the row itself to be the measured
// view.

export function LabeledField({
  label,
  children,
  onLayout,
}: {
  label: string;
  children: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  return (
    <View className="gap-1.5" onLayout={onLayout}>
      <Text className="text-xs text-muted-foreground">{label}</Text>
      {children}
    </View>
  );
}
