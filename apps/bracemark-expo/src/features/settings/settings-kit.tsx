import { type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react-native';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';

// The settings design system: the column, the headings, the row, the notice —
// the RN port of bracemark-web's `(app)/settings/_components/settings-kit.tsx`,
// component for component and step for step.
//
// WHY THIS EXISTS. Every one of these was typed by hand in each section, and the
// count is the argument, the same one web's file makes: the page wrapper
// (`px-6 py-8`) appeared in all seven sections, the section heading in all seven,
// the block heading (`mt-10` + `text-base font-medium` + a muted line) nineteen
// times — in four different top margins — and the error box in five, in three
// different treatments. Self-containment is right for a section's LOGIC; it is
// how seven sections drift into looking like seven products. A control the user
// has never seen should sit at the same inset, on the same hairline, at the same
// heading step as the one they saw a minute ago — that consistency is the entire
// design of a settings surface.
//
// The measure is `max-w-2xl` with `px-6`, which is what bracemark-web's settings
// pane and the browser extension's options page are both set to. On a phone the
// cap never binds and this is just the padding; on a tablet it stops a column of
// controls stretching to 1024px. Three surfaces, one measure — a user who has
// seen one should not be able to tell they have changed apps.
//
// WHAT IS NOT PORTED: web's `focus-visible:` rings, which have no meaning
// without a keyboard, and its `hover:` states, which have no meaning without a
// pointer. Both become `active:` — the press feedback that IS the native
// affordance. The gap that leaves is real and is filled twice over: web's rows
// are `<button>`s that announce themselves, so these Pressables declare
// `role="button"` to say the same thing (docs/accessibility.md — a Pressable
// inherits no role), and the ones that navigate carry the chevron as their
// visible affordance.

// The column every section renders into, inside the page's ScrollView
// (scroll-host.tsx). `gap-8` is the rhythm between a section's top-level blocks,
// so no section adds its own top margin to the ones it happens to have — the
// spacing is a property of the page, not of whoever wrote the block. Nest a
// plain View for anything that needs to sit tighter than that.
//
// The four steps are 32 / 16 / 8 / 12 — section, heading-to-content
// (SettingsGroup), tab-strip-to-panel (the Tabs `gap-2`), row-to-row (the
// RadioGroup `gap-3`), and they are web's four, because the measure is not the
// only thing the three surfaces hold in common. They were 24 / 12 / 8 / 12: two
// values wearing four hats, where a whole section break measured the same as a
// heading's own content and a heading sat no closer to its first row than two
// rows sat to each other. Spacing is the only thing grouping these blocks — no
// dividers, no cards — so each level has to be legibly its own size.
export function SettingsPane({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <View className={cn('w-full max-w-2xl gap-8 self-center px-6 py-8', className)}>
      {children}
    </View>
  );
}

// The section's title and the line under it. This is the screen's heading — the
// topbar's copy of the section name is a surface label on a bar the drawer can
// cover, not the document's title, so the section you navigated to gets the
// weight here. Sub-views (Change password, Import data) render this too: they
// replace the whole pane rather than nesting inside it, so each is the heading
// while it is up.
//
// `back` turns it into a sub-view's header. Account and Data both drill from an
// overview into sub-views, and both had their own copy of the back link sitting
// loose above the title — so it belongs to the header rather than to the pane,
// and the pair moves as one block.
export function SettingsHeader({
  title,
  description,
  back,
}: {
  title: string;
  description?: ReactNode;
  // Labelled with the section it returns to, not "Back": you got here from a row
  // named for this view, so naming the destination closes that loop.
  back?: { label: string; onPress: () => void };
}) {
  // TWO nested columns, not one column plus a margin — the web kit's twin
  // (settings-kit.tsx there) carries the full note. The link is 12 from the
  // title, the title is 4 from its description, and the `mb-3` this replaced sat
  // inside the `gap-1` column and silently added to it: the link was 16 from the
  // title while the code said 12, on both platforms.
  //
  // The description is a COLUMN so a sub-view with more than one paragraph (Delete
  // all data) keeps its prose in the header at 4 from the title, instead of paying
  // the pane's 32 to reach its own first sentence. Its paragraphs stack 16 apart —
  // the web twin carries why that is neither the 12 it started at nor the pane's
  // 32. Unlike that twin the parts do NOT inherit — a View passes no text style
  // down — so each `<Text>` a caller stacks here carries its own
  // `text-sm text-muted-foreground`.
  return (
    <View className="gap-3">
      {back ? <SettingsBackLink label={back.label} onPress={back.onPress} /> : null}
      <View className="gap-1">
        <Text role="heading" aria-level="1" className="text-xl font-semibold tracking-tight">
          {title}
        </Text>
        {description ? (
          <View className="gap-4">
            {typeof description === 'string' ? (
              <Text className="text-sm text-muted-foreground">{description}</Text>
            ) : (
              description
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

// One block within a section — "Link layout", "Theme", "App lock". The heading
// step (`text-base font-medium`) is one below SettingsHeader and one above body
// text, and the gap between the heading and its controls is fixed here so four
// blocks in a row can't each pick their own. `gap-4` has to stay clear of
// whatever the content spaces its OWN items by — a RadioGroup's rows are 12
// apart, so at the `gap-3` this once was, the heading read as just another row
// in the list.
export function SettingsGroup({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <View className={cn('gap-4', className)}>
      <View className="gap-1">
        <Text role="heading" aria-level="2" className="text-base font-medium">
          {title}
        </Text>
        {description ? <Text className="text-sm text-muted-foreground">{description}</Text> : null}
      </View>
      {children}
    </View>
  );
}

// The bordered row — the workhorse of this surface. Four shapes, one component,
// because they were three components with the same body:
//
//   - a STATIC row (`Username`, the current plan): a label, a value, and
//     optionally something to press on the right;
//   - a DRILL-DOWN row (`onPress`): the whole row is the control and it grows a
//     chevron, which is the affordance that says a sub-view is behind it;
//   - an EXTERNAL row (`external`, with `onPress` doing the `Linking.openURL`):
//     the same row with an out-arrow instead of the chevron. The distinction is
//     the whole point — a chevron promises a sub-view of this screen, and these
//     leave the app for the system browser, which on iOS means the app goes to
//     the background (Settings → About is a screen of them). Web's peer takes an
//     `href` and renders a real anchor; RN has no anchor, so the press handler
//     stays the caller's and this prop only picks the glyph.
//   - a DESTRUCTIVE drill-down (`destructive`), where the icon and title go red
//     but the description does NOT — a whole red row reads as an error state
//     rather than a door to a dangerous place.
export function SettingsRow({
  icon,
  title,
  description,
  action,
  onPress,
  external,
  destructive,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  // Trailing control for a static row (a Refresh button, a Switch). Ignored when
  // `onPress` is set — a control inside a pressable row would swallow one of the
  // two presses, and which one it swallows is a platform detail.
  action?: ReactNode;
  onPress?: () => void;
  // Only meaningful with `onPress`: swaps the chevron for the out-arrow.
  external?: boolean;
  destructive?: boolean;
  className?: string;
}) {
  const body = (
    <>
      {icon ? <View className="shrink-0">{icon}</View> : null}
      <View className="min-w-0 flex-1 gap-0.5">
        {typeof title === 'string' ? (
          <Text className={cn('font-medium', destructive && 'text-destructive')}>{title}</Text>
        ) : (
          title
        )}
        {/* A COLUMN, not one line. Most descriptions are a single string, but the
            sync row passes several (status, error detail, pending count, the
            lazy-content note) that each need their own line — run together they
            read as "Last synced just nowSaved page copies and images…". */}
        {description ? (
          <View className="gap-0.5">
            {typeof description === 'string' ? (
              <Text className="text-sm text-muted-foreground">{description}</Text>
            ) : (
              description
            )}
          </View>
        ) : null}
      </View>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        role="button"
        onPress={onPress}
        className={cn(
          'w-full flex-row items-center gap-3 rounded-lg border border-border p-4 active:bg-muted/40',
          className,
        )}
      >
        {body}
        <Icon
          as={external ? ArrowUpRight : ChevronRight}
          className="size-4 shrink-0 text-muted-foreground"
        />
      </Pressable>
    );
  }

  return (
    <View
      className={cn(
        'flex-row items-start justify-between gap-4 rounded-lg border border-border p-4',
        className,
      )}
    >
      <View className="min-w-0 flex-1 flex-row items-start gap-3">{body}</View>
      {action ? <View className="shrink-0">{action}</View> : null}
    </View>
  );
}

// A strip of text that isn't a control: a warning above a form, a failed write, a
// transient "Finishing your upgrade…". These were several different treatments —
// `bg-destructive/10` here, a bordered box with an icon there, bare red text
// elsewhere — so `tone` now picks one of three and nothing else is available.
//
//   - `info`    — a standing fact or a caution. Bordered, body colour, quiet.
//   - `error`   — something failed. Tinted, and the only tone that uses red.
//   - `pending` — a transient status the user is waiting on.
//
// `error` also carries `role="alert"` (see components/error-text.tsx for why, and
// for the iOS caveat) — the same thing the web twin's SettingsNotice does. The
// other two tones must NOT have it: they're standing text, not events. The role
// rides the message Text, so a NON-string child has to carry its own; every
// current error caller passes a string.
export function SettingsNotice({
  tone = 'info',
  icon,
  className,
  children,
}: {
  tone?: 'info' | 'error' | 'pending';
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <View
      className={cn(
        'flex-row items-start gap-2 rounded-lg px-3 py-2.5',
        tone === 'info' && 'border border-border',
        tone === 'error' && 'bg-destructive/10',
        tone === 'pending' && 'bg-muted/50',
        className,
      )}
    >
      {icon ? <View className="mt-0.5 shrink-0">{icon}</View> : null}
      <View className="min-w-0 flex-1">
        {typeof children === 'string' ? (
          <Text
            role={tone === 'error' ? 'alert' : undefined}
            className={cn(
              'text-sm',
              tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

// Back out of a sub-view to its section's overview. Usually reached through
// SettingsHeader's `back` prop rather than rendered directly.
export function SettingsBackLink({
  label,
  onPress,
  className,
}: {
  label: string;
  onPress: () => void;
  className?: string;
}) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
      className={cn('-ml-1 flex-row items-center gap-1 self-start rounded-sm', className)}
    >
      <Icon as={ChevronLeft} className="size-4 text-muted-foreground" />
      <Text className="text-sm text-muted-foreground">{label}</Text>
    </Pressable>
  );
}
