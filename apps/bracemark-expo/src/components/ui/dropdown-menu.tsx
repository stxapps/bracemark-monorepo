import * as React from 'react';
import {
  type GestureResponderEvent,
  Platform,
  type StyleProp,
  StyleSheet,
  Text as RNText,
  View,
  type ViewStyle,
} from 'react-native';
import { KeyboardController } from 'react-native-keyboard-controller';
import { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay as RNFullWindowOverlay } from 'react-native-screens';
import * as DropdownMenuPrimitive from '@rn-primitives/dropdown-menu';
import { Check, ChevronDown, ChevronRight, ChevronUp } from 'lucide-react-native';

import { cn } from '../../lib/utils';
import { Icon } from './icon';
import { NativeOnlyAnimatedView, POPUP_FADE_MS } from './native-only-animated-view';
import { Text, TextClassContext } from './text';

// react-native-reusables `dropdown-menu` (uniwind variant), copied from the
// registry — see docs/setup.md for why the copy is manual (the CLI needs
// tsconfig path aliases; this app uses relative imports). Local changes vs
// upstream: imports rewritten to relative, plus an explicit `import * as React`
// (upstream leans on the UMD global type for `React.ComponentProps`), plus the
// radii — `rounded-2xl` on both content surfaces and `rounded-xl` on every
// row, which is web-ui's shape system rather than the registry's `md`/`sm`
// (docs/theme.md, _the radius scale_). The row inset came with them — `px-3`
// and `gap-2.5`, web-ui's values — as did the label's step (`text-xs
// text-muted-foreground`, where the registry had a full-strength `text-sm
// font-medium` that read as a row rather than a heading) and the separator's
// `bg-border/50`. The `inset` prop follows that row inset rather than the
// registry's: `pl-9.5` is `px-3` + a `size-4` glyph + `gap-2.5` = 38, which is
// where a leading-icon row puts its text. The registry's `pl-8` was 32 —
// arithmetically right for the `px-2`/`gap-2` row it shipped with, and 6px short
// the moment that row took web's values, which is exactly the kind of half-ported
// number this header exists to catch. It reaches CheckboxItem and RadioItem here
// as it does on web. The state indicator's SIDE is web's too — the check and the
// radio dot sit at the TRAILING edge (`pr-8 pl-3`, `absolute right-2`), not the
// registry's leading gutter (docs/theme.md, _the two kits_). Nothing imports
// CheckboxItem or RadioItem today; ported anyway, for the reason
// DropdownMenuLabel below carries, and because the two indicators this app
// actually ships are already trailing and hand-rolled (the settings topbar's
// "you are here" check on web, `features/share/share-list-picker.tsx` here).
// And DropdownMenuTrigger is a wrapper rather than the bare primitive, so a
// keyboard left up behind the menu goes away before the menu is placed (see
// there) — which is also why DropdownMenu is a wrapper, carrying that hand-off
// to the content's fade. The fade itself is web-ui's 100ms, not the
// registry's undated FadeIn (Reanimated's 300) — POPUP_FADE_MS in
// native-only-animated-view.tsx. Content renders through @rn-primitives/portal —
// the root `_layout.tsx` mounts the default `<PortalHost />` it lands in.

const MENU_FADE_IN = FadeIn.duration(POPUP_FADE_MS).reduceMotion(ReduceMotion.System);

// Whether the open in progress waited on a keyboard to go (DropdownMenuTrigger
// below), for DropdownMenuContent to skip its fade — see the end of the
// trigger's note. The default stands for a Content rendered under a bare
// primitive Root: it fades, as it always did.
const KeyboardHandOffContext = React.createContext<{
  waitedOnKeyboard: boolean;
  setWaitedOnKeyboard: (waited: boolean) => void;
}>({ waitedOnKeyboard: false, setWaitedOnKeyboard: () => undefined });

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const [waitedOnKeyboard, setWaitedOnKeyboard] = React.useState(false);
  const handOff = React.useMemo(() => ({ waitedOnKeyboard, setWaitedOnKeyboard }), [waitedOnKeyboard]);
  return (
    <KeyboardHandOffContext.Provider value={handOff}>
      <DropdownMenuPrimitive.Root {...props} />
    </KeyboardHandOffContext.Provider>
  );
}

// How long to wait for `keyboardDidHide` before placing the menu anyway. A hide
// takes ~250ms on iOS and a little more on Android; this only bounds the case
// where the event never arrives, which would otherwise leave the menu open but
// never drawn — a ⋯ that looks dead.
const KEYBOARD_SETTLE_TIMEOUT_MS = 1000;

// Drops a keyboard left up behind the menu, and places the menu only once it is
// gone. The same job DialogContent does on open (dialog.tsx), and done here for
// the same reason — once, for every host, rather than in each trigger: the
// field focused before the press survives it (every scroller here persists taps,
// `"handled"`), stays focused behind the menu and takes the next keystroke
// unseen (docs/soft-keyboard.md, _dismissal_). A settings row's ⋯ pressed from
// that row's own rename field is the specimen.
//
// It cannot be the dialog's one-line dismiss-on-open, because a dialog is
// CENTRED and a menu is ANCHORED. The primitive measures its trigger exactly
// once, in this press, and places the content from that stored
// `triggerPosition` for as long as it is open — nothing re-measures. Dropping
// the keyboard moves the trigger out from under it: the settings page's
// KeyboardAwareScrollView (scroll-host.tsx) scrolls back to where it was before
// the keyboard rose, so a row it had scrolled up to reveal slides back down by
// up to the keyboard's height, and a menu opened from it is left hanging where
// the ⋯ used to be. So when a keyboard is up, the press opens the menu (the
// caller's `onOpenChange` sees one `true`, as always) but withholds its
// position, and measures again once the keyboard is down — by which point the
// scroll-back, which keyboard-controller drives frame by frame with the
// keyboard's own animation, has finished. The cost is one keyboard animation
// before the menu appears, and only when there was a keyboard to drop.
//
// That wait is not what made it feel slow; the fade stacked after it was. The
// keyboard going down is already motion that answers the press, and a fade on
// top only postpones the moment the menu is usable, so a menu opened this way
// appears without one (`waitedOnKeyboard`, read by DropdownMenuContent). That
// leaves the keyboard's ~250ms plus a layout pass. The wait itself cannot be
// cut: keyboard-controller's `dismiss` takes no `animated` option, and the OS
// owns the hide on both platforms (`resignFirstResponder`,
// `hideSoftInputFromWindow`).
//
// Withholding is ordering-safe because Fabric's `measure` is SYNCHRONOUS
// (UIManagerBinding.cpp calls the callback before returning): the primitive's
// onPress has already stored the stale position by the time it calls ours, and
// clearing it lands in the same batched update, so the primitive's Portal —
// which renders nothing without a position — never mounts the stale placement,
// not even for a frame. `open` here is the value that press read, so a press
// that CLOSES the menu is left alone.
//
// Dropping the keyboard blurs the field, and RenameField (settings/table-kit.tsx)
// commits on `onEndEditing` — so opening a row's ⋯ mid-rename saves the name.
// That is web's behaviour too: the click moves focus to the trigger, and the
// field commits on blur. The menu's Rename item focuses the field again.
function DropdownMenuTrigger({
  onPress,
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  const { open, setTriggerPosition } = DropdownMenuPrimitive.useRootContext();
  const { setWaitedOnKeyboard } = React.useContext(KeyboardHandOffContext);
  const triggerRef = React.useRef<DropdownMenuPrimitive.TriggerRef | null>(null);
  const composedRef = React.useCallback(
    (node: DropdownMenuPrimitive.TriggerRef | null) => {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  function onTriggerPress(ev: GestureResponderEvent) {
    onPress?.(ev);
    if (open || Platform.OS === 'web') return;
    const keyboardUp = KeyboardController.isVisible();
    setWaitedOnKeyboard(keyboardUp);
    if (!keyboardUp) return;
    setTriggerPosition(null);
    void Promise.race([
      KeyboardController.dismiss(),
      new Promise((resolve) => setTimeout(resolve, KEYBOARD_SETTLE_TIMEOUT_MS)),
    ]).then(() => {
      triggerRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
        setTriggerPosition({ width, height, pageX, pageY });
      });
    });
  }

  return <DropdownMenuPrimitive.Trigger ref={composedRef} onPress={onTriggerPress} {...props} />;
}

const DropdownMenuGroup = DropdownMenuPrimitive.Group;

const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  iconClassName,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  children?: React.ReactNode;
  iconClassName?: string;
  inset?: boolean;
}) {
  const { open } = DropdownMenuPrimitive.useSubContext();
  const icon = Platform.OS === 'web' ? ChevronRight : open ? ChevronUp : ChevronDown;
  return (
    <TextClassContext.Provider
      value={cn(
        'text-sm select-none group-active:text-accent-foreground',
        open && 'text-accent-foreground',
      )}
    >
      <DropdownMenuPrimitive.SubTrigger
        className={cn(
          'group flex flex-row items-center justify-between gap-2.5 rounded-xl px-3 py-2 active:bg-accent sm:py-1.5',
          Platform.select({
            web: 'cursor-default outline-none focus:bg-accent focus:text-accent-foreground [&_svg]:pointer-events-none',
          }),
          className,
          open && 'bg-accent',
          inset && 'pl-9.5',
        )}
        {...props}
      >
        {children}
        <Icon as={icon} className={cn('size-4 shrink-0 text-foreground', iconClassName)} />
      </DropdownMenuPrimitive.SubTrigger>
    </TextClassContext.Provider>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <NativeOnlyAnimatedView entering={MENU_FADE_IN}>
      <DropdownMenuPrimitive.SubContent
        className={cn(
          'overflow-hidden rounded-2xl border border-border bg-popover p-1 shadow-lg shadow-black/5',
          Platform.select({
            web: 'animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 fade-in-0 data-[state=closed]:zoom-out-95 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-32 origin-(--radix-context-menu-content-transform-origin)',
          }),
          className,
        )}
        {...props}
      />
    </NativeOnlyAnimatedView>
  );
}

const FullWindowOverlay = Platform.OS === 'ios' ? RNFullWindowOverlay : React.Fragment;

function DropdownMenuContent({
  className,
  insets,
  overlayClassName,
  overlayStyle,
  portalHost,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  overlayStyle?: StyleProp<ViewStyle>;
  overlayClassName?: string;
  portalHost?: string;
}) {
  // The collision padding @rn-primitives clamps the menu to, and it DEFAULTS to
  // the safe-area insets rather than waiting for a caller to pass them
  // (docs/safe-area.md, _safe area on native_). The clamp is about the CONTENT,
  // not the trigger: `getSidePosition` places a menu that doesn't fit below its
  // trigger at `dimensions.height - insets.bottom - contentHeight`, against
  // `Dimensions.get('screen')` — the PHYSICAL screen — with `insets.bottom`
  // defaulting to 0. So a menu bottoms out flush with the hardware edge no
  // matter how safely its trigger sits: the bulk-edit bar's ⋯ (a bar anchored to
  // the bottom of the screen, so its menu is clamped every single time) and the
  // last visible row's ⋯ both put their final item inside the home indicator's
  // own swipe region. Same reasoning as DialogOverlay's gutter in dialog.tsx —
  // portaled content inherits no screen insets — and the same +8, which is also
  // web's `collisionPadding` default (web-ui/components/ui/dropdown-menu.tsx).
  //
  // A caller may still override with its own `insets`; passing `{}` opts out.
  // Native-only in effect: on web @rn-primitives defers to Radix, which does its
  // own collision handling and ignores this prop.
  const safeAreaInsets = useSafeAreaInsets();
  const collisionInsets = React.useMemo(
    () =>
      insets ?? {
        top: safeAreaInsets.top + 8,
        bottom: safeAreaInsets.bottom + 8,
        left: safeAreaInsets.left + 8,
        right: safeAreaInsets.right + 8,
      },
    [insets, safeAreaInsets.top, safeAreaInsets.bottom, safeAreaInsets.left, safeAreaInsets.right],
  );
  const { waitedOnKeyboard } = React.useContext(KeyboardHandOffContext);

  return (
    <DropdownMenuPrimitive.Portal hostName={portalHost}>
      <FullWindowOverlay>
        <DropdownMenuPrimitive.Overlay
          style={Platform.select({
            web: overlayStyle ?? undefined,
            native: overlayStyle
              ? StyleSheet.flatten([
                  StyleSheet.absoluteFill,
                  overlayStyle as typeof StyleSheet.absoluteFill,
                ])
              : StyleSheet.absoluteFill,
          })}
          className={overlayClassName}
          asChild={Platform.OS !== 'web'}
        >
          <NativeOnlyAnimatedView
            entering={waitedOnKeyboard ? undefined : MENU_FADE_IN}
            as="Pressable"
          >
            <TextClassContext.Provider value="text-popover-foreground">
              <DropdownMenuPrimitive.Content
                insets={collisionInsets}
                className={cn(
                  'min-w-32 overflow-hidden rounded-2xl border border-border bg-popover p-1 shadow-lg shadow-black/5',
                  Platform.select({
                    web: cn(
                      'animate-in fade-in-0 zoom-in-95 z-50 max-h-(--radix-context-menu-content-available-height) origin-(--radix-context-menu-content-transform-origin) cursor-default',
                      props.side === 'bottom' && 'slide-in-from-top-2',
                      props.side === 'top' && 'slide-in-from-bottom-2',
                    ),
                  }),
                  className,
                )}
                {...props}
              />
            </TextClassContext.Provider>
          </NativeOnlyAnimatedView>
        </DropdownMenuPrimitive.Overlay>
      </FullWindowOverlay>
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  className?: string;
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <TextClassContext.Provider
      value={cn(
        'select-none text-sm text-popover-foreground group-active:text-popover-foreground',
        variant === 'destructive' && 'text-destructive group-active:text-destructive',
      )}
    >
      <DropdownMenuPrimitive.Item
        className={cn(
          'group relative flex flex-row items-center gap-2.5 rounded-xl px-3 py-2 active:bg-accent sm:py-1.5',
          Platform.select({
            web: cn(
              'cursor-default outline-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none',
              variant === 'destructive' && 'focus:bg-destructive/10 dark:focus:bg-destructive/20',
            ),
          }),
          variant === 'destructive' && 'active:bg-destructive/10 dark:active:bg-destructive/20',
          props.disabled && 'opacity-50',
          inset && 'pl-9.5',
          className,
        )}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  children?: React.ReactNode;
  inset?: boolean;
}) {
  return (
    <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
      <DropdownMenuPrimitive.CheckboxItem
        className={cn(
          'group relative flex flex-row items-center gap-2.5 rounded-xl py-2 pr-8 pl-3 active:bg-accent sm:py-1.5',
          Platform.select({
            web: 'cursor-default outline-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none',
          }),
          props.disabled && 'opacity-50',
          inset && 'pl-9.5',
          className,
        )}
        {...props}
      >
        <View className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
          <DropdownMenuPrimitive.ItemIndicator>
            <Icon
              as={Check}
              className={cn(
                'size-4 text-foreground',
                Platform.select({ web: 'pointer-events-none' }),
              )}
            />
          </DropdownMenuPrimitive.ItemIndicator>
        </View>
        {children}
      </DropdownMenuPrimitive.CheckboxItem>
    </TextClassContext.Provider>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  children?: React.ReactNode;
  inset?: boolean;
}) {
  return (
    <TextClassContext.Provider value="text-sm text-popover-foreground select-none group-active:text-accent-foreground">
      <DropdownMenuPrimitive.RadioItem
        className={cn(
          'group relative flex flex-row items-center gap-2.5 rounded-xl py-2 pr-8 pl-3 active:bg-accent sm:py-1.5',
          Platform.select({
            web: 'cursor-default outline-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none',
          }),
          props.disabled && 'opacity-50',
          inset && 'pl-9.5',
          className,
        )}
        {...props}
      >
        <View className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
          <DropdownMenuPrimitive.ItemIndicator>
            <View className="h-2 w-2 rounded-full bg-foreground" />
          </DropdownMenuPrimitive.ItemIndicator>
        </View>
        {children}
      </DropdownMenuPrimitive.RadioItem>
    </TextClassContext.Provider>
  );
}

// `asChild` + ui/text's Text, diverging from the registry copy: without it
// rn-primitives renders **react-native's own Text** here (`Component = asChild ?
// Slot : Text`), which takes neither `font-sans` nor the font-scale cap.
// alert-dialog.tsx's AlertDialogTitle carries the full note. Nothing imports
// this component today — it is fixed anyway, because the next thing that does
// would inherit the bug silently.
function DropdownMenuLabel({
  className,
  inset,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Label>, 'asChild'> & {
  className?: string;
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label asChild>
      <Text
        className={cn('px-3 py-2.5 text-xs text-muted-foreground', inset && 'pl-9.5', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Label>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border/50', className)}
      {...props}
    />
  );
}

// Left on a bare RN Text, and it is the last one in this file: nothing imports
// DropdownMenuShortcut, and a keyboard-shortcut hint has no place on a phone —
// deleting it would diverge further from the registry copy than leaving it.
// Anything that DOES start using it should switch to ui/text's Text first.
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<typeof RNText>) {
  return (
    <RNText
      className={cn('ml-auto text-xs tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
