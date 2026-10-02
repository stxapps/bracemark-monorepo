// The one way this app renders an inline error message.
//
// It exists for `role="alert"`, not for the four classes of styling. Every error
// here arrives as the RESULT of a press with nothing else changing on screen — a
// bare <Text> leaves a screen-reader user with a button that silently re-enables
// and no reason why. A missing `role` prop is caught by nothing: no lint rule, no
// type error, no test. It had been left off 13 of the 17 error sites in this app
// before this component existed, which is the argument for a component rather
// than a convention.
//
// The web twin gets the same behaviour from web-ui's `FieldError` (which renders
// `role="alert"`) inside the auth forms, and from `SettingsNotice tone="error"`
// plus a bare `<p role="alert">` everywhere else. This is NOT named `FieldError`
// on purpose: there is no Field kit on this side, and most of the sites it serves
// pair with a plain `<p>` on web — the name would promise a twin that isn't there.
//
// ⚠ iOS: `role="alert"` compiles to `accessibilityRole="alert"`, which TalkBack
// announces and VoiceOver ignores — there is no iOS trait for it. If iOS needs to
// actually speak these, the fix is `AccessibilityInfo.announceForAccessibility` in
// an effect keyed on the message, and THIS is the one place to add it. That is the
// whole reason the role isn't just typed at each call site.

import { View } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';

import { cn } from '../lib/utils';
import { Icon } from './ui/icon';
import { Text } from './ui/text';
import { FirstLineSlot } from './first-line-slot';

// `warning` is amber, not red: it's the tone for something the user can proceed
// through (a malformed URL they may still want to save), where `error` is a
// failure they can't. Both announce — the distinction is colour and wording, not
// urgency to a screen reader.
const TONE = {
  error: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-500',
} as const;

export function ErrorText({
  tone = 'error',
  icon,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Text>, 'role' | 'children'> & {
  tone?: keyof typeof TONE;
  // A leading Lucide glyph, tinted to match `tone` and held on the first line
  // (FirstLineSlot). Decorative — the message itself is what carries the alert role.
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  // `className` styles the ROOT — which is the Text without an icon and the row
  // with one — so a caller's `mt-3` lands in the right place either way, and
  // `text-xs` reaches the message on the (icon-less) sites that want it.
  //
  // The role rides the Text, never the wrapping View: the Text node is what gets
  // announced, and an un-`accessible` View contributes nothing to announce.
  if (!icon) {
    return (
      <Text role="alert" className={cn('text-sm', TONE[tone], className)} {...props}>
        {children}
      </Text>
    );
  }

  return (
    <View className={cn('flex-row items-start gap-2', className)}>
      <FirstLineSlot textClassName="text-sm">
        <Icon as={icon} className={cn('size-4', TONE[tone])} />
      </FirstLineSlot>
      <Text role="alert" className={cn('min-w-0 flex-1 text-sm', TONE[tone])} {...props}>
        {children}
      </Text>
    </View>
  );
}
