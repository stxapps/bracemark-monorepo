import { ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '@stxapps/web-ui/lib/utils';

// The settings design system: the column, the headings, the row, the notice.
//
// WHY THIS EXISTS. Every one of these was typed by hand in each section, and the
// count is the argument: the page wrapper appeared 10 times, the section heading
// 10 times, the bordered row 18 times — in four different paddings — and both
// `ActionRow` and `BackLink` existed twice, byte-identical, under a comment
// explaining that the sections are "self-contained by design". Self-contained is
// right for a section's LOGIC; it is how the seven sections drifted into looking
// like seven products. A control the user has never seen should sit at the same
// inset, on the same hairline, at the same heading step as the one they saw a
// minute ago — that consistency is the entire design of a settings surface.
//
// The measure is `max-w-2xl` with `px-6`, which is also the browser extension's
// options page (its `OptionsShell` says so, and cites this page as the source).
// The two are the same product's settings reached from two places; keep them
// equal, and change them together.

// The scrolling column every section renders into. `gap-8` is the rhythm between
// a section's top-level blocks, so no section adds its own `mt-*` to the ones it
// happens to have — the spacing is a property of the page, not of whoever wrote
// the block. Nest a plain div for anything that needs to sit tighter than that.
//
// The four steps on this surface are 32 / 16 / 8 / 12 — section, heading-to-content
// (SettingsGroup), tab-strip-to-panel (the Tabs default `gap-2`), row-to-row (the
// RadioGroup default `gap-3`). They were 24 / 12 / 8 / 12, which is two values
// wearing four hats: a whole section break measured the same as a heading's own
// content, and a heading sat no closer to its first row than two rows sat to each
// other. Spacing is the only thing grouping these blocks — no dividers, no cards —
// so each level has to be legibly its own size.
export function SettingsPane({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-8', className)}>
      {children}
    </div>
  );
}

// The section's title and the line under it. This is the page's `h1` — the
// topbar's "Settings" is a surface label, not a heading (see topbar.tsx), so the
// section you navigated to is the document's title and gets the weight. Sub-views
// (Change password, Import data) render this too: they replace the whole pane
// rather than nesting inside it, so each is the h1 while it's up.
//
// `back` turns it into a sub-view's header. Account and Data both drill from an
// overview into sub-views (Change password, Import data, …), and both had their
// own copy of the back link sitting loose above the title — so it belongs to the
// header rather than to the pane, and the pair moves as one block.
export function SettingsHeader({
  title,
  description,
  back,
}: {
  title: string;
  description?: React.ReactNode;
  // Labelled with the section it returns to, not "Back": you got here from a row
  // named for this view, so naming the destination closes that loop.
  back?: { label: string; onClick: () => void };
}) {
  // TWO nested columns, not one column plus a margin. The link is 12 from the
  // title and the title is 4 from its description, and those are different
  // relationships: the description is part of the title block, the link is a
  // control sitting above it. Spelling both as gaps keeps each step readable as
  // the number it is — the `mb-3` this replaced sat INSIDE the `gap-1` column and
  // silently added to it, so the link was 16 from the title while the code said
  // 12. web-ui's StepHeader (create-account-form.tsx) is the same shape at the
  // same 12: same chevron, same `text-sm` link, same `text-xl` h1.
  //
  // 12-then-4 also has to stay legible as two steps. At 8 the pair would read
  // 8-then-4, which is too fine a distinction to see — the link would look like
  // a second line of the title block rather than the way out of it.
  //
  // The description is a COLUMN, for the reason SettingsRow's is (see there). Most
  // are one string, but Delete all data needs three paragraphs — what it does, what
  // it spares, and the red line — and a sub-view that keeps its prose OUTSIDE the
  // header pays the pane's 32 to reach its own first sentence, where the sub-view
  // next to it pays 4. Same screen, same role, eight times the gap. Pass a string
  // and it stays one `<p>`; pass `<p>`s and they stack 16 apart, inheriting the
  // size and colour so a caller only spells what differs (the red line's weight).
  //
  // 16 rather than the 12 this started at, which read tight against paragraphs
  // three and four lines long — `text-sm` leads at 20, so 12 leaves the break only
  // three times the space between two lines of the SAME paragraph, and at that
  // length the eye wants more before it accepts a new one has begun. It cannot go
  // to the 32 the pane steps by: the checkbox block below is 32 from the last
  // paragraph, so matching it would flatten the screen into one evenly-spaced
  // stack with no levels in it. 16 is the only value between the two. It is also
  // SettingsGroup's heading-to-content step, which is a collision on paper only —
  // no screen with a multi-paragraph description renders a SettingsGroup, and the
  // two live at different depths if one ever does.
  return (
    <div className={cn('flex flex-col gap-3')}>
      {back ? <SettingsBackLink label={back.label} onClick={back.onClick} /> : null}
      <div className={cn('flex flex-col gap-1')}>
        <h1 className={cn('text-xl font-semibold tracking-tight')}>{title}</h1>
        {description ? (
          <div className={cn('flex flex-col gap-4 text-sm text-muted-foreground')}>
            {typeof description === 'string' ? <p>{description}</p> : description}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// One block within a section — "Link layout", "Theme", "App lock". The `h2` step
// (`text-base font-medium`) is one below SettingsHeader and one above body text,
// and the gap between the heading and its controls is fixed here so four blocks
// in a row can't each pick their own. `gap-4` has to stay clear of whatever the
// content spaces its OWN items by — a RadioGroup's rows are 12 apart, so at the
// `gap-3` this once was, the heading read as just another row in the list.
export function SettingsGroup({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('flex flex-col gap-4', className)}>
      <div className={cn('flex flex-col gap-1')}>
        <h2 className={cn('text-base font-medium')}>{title}</h2>
        {description ? <p className={cn('text-sm text-muted-foreground')}>{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

// The bordered row — the workhorse of this surface. Four shapes, one component,
// because they were three components with the same body:
//
//   - a STATIC row (`Username`, the current plan): a label, a value, and
//     optionally something to press on the right;
//   - a DRILL-DOWN row (`onClick`): the whole row is the button and it grows a
//     chevron, which is the affordance that says a sub-view is behind it;
//   - an EXTERNAL row (`href`): the same row as a real `<a>`, so it keeps
//     middle-click, "open in new tab" and "copy link address" — things a
//     `<button>` that calls `window.open` silently takes away. Its trailing glyph
//     is an out-arrow rather than the chevron, because the chevron promises a
//     sub-view of THIS surface and these leave the app entirely (Settings → About
//     is a page of them). New tab, always: the app is a live session behind a
//     sync loop, and reading the terms should not close it.
//   - a DESTRUCTIVE drill-down (`destructive`), where the icon and title go red
//     but the description does NOT — a whole red row reads as an error state
//     rather than a door to a dangerous place.
//
// `title` and `description` are spans, not headings: these are controls in a
// list, and promoting each to an `h4` would put a dozen empty levels into the
// document outline for a screen reader to walk through.
export function SettingsRow({
  icon,
  title,
  description,
  action,
  onClick,
  href,
  destructive,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  // Trailing control for a static row (a Refresh button, a Switch). Ignored when
  // `onClick` or `href` is set — a button inside a button is not a thing.
  action?: React.ReactNode;
  onClick?: () => void;
  // An absolute URL on another origin (the marketing site). Cross-origin by
  // definition — an in-app destination is a route, and routes are `onClick` +
  // router, not this.
  href?: string;
  destructive?: boolean;
  className?: string;
}) {
  const body = (
    <>
      {icon ? (
        <span
          className={cn('shrink-0', destructive ? 'text-destructive' : 'text-muted-foreground')}
        >
          {icon}
        </span>
      ) : null}
      <span className={cn('flex min-w-0 flex-1 flex-col gap-0.5')}>
        <span className={cn('font-medium', destructive && 'text-destructive')}>{title}</span>
        {/* A COLUMN, not an inline span. Most descriptions are one string, but the
            sync row passes several spans (status, error detail, pending count, the
            lazy-content note) that each need their own line — inline, they ran
            together into "Last synced just nowSaved page copies and images…". */}
        {description ? (
          <span className={cn('flex flex-col gap-0.5 text-sm text-muted-foreground')}>
            {description}
          </span>
        ) : null}
      </span>
    </>
  );

  // One class list for both pressable shapes, so an anchor row and a button row
  // are indistinguishable until you read the trailing glyph.
  const pressable = cn(
    'flex w-full items-center gap-3 rounded-lg border border-border p-4 text-left transition-colors',
    'hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
    className,
  );

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={pressable}>
        {body}
        <ArrowUpRight className={cn('size-4 shrink-0 text-muted-foreground')} aria-hidden="true" />
      </a>
    );
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={pressable}>
        {body}
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground')} />
      </button>
    );
  }

  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 rounded-lg border border-border p-4',
        className,
      )}
    >
      <div className={cn('flex min-w-0 flex-1 items-start gap-3')}>{body}</div>
      {action ? <div className={cn('shrink-0')}>{action}</div> : null}
    </div>
  );
}

// A strip of text that isn't a control: a warning above a form, a failed write, a
// transient "Finishing your upgrade…". These were five different treatments —
// `bg-destructive/10` here, a bordered box with an icon there, bare red text
// elsewhere — so `tone` now picks one of three and nothing else is available.
//
//   - `info`    — a standing fact or a caution. Bordered, body colour, quiet.
//   - `error`   — something failed. Tinted, and the only tone that uses red.
//   - `pending` — a transient status the user is waiting on. Bordered AND
//     tinted: the hairline is what makes it a block, the fill is what separates
//     it from `info`.
//
// WHY `pending` NEEDS THE BORDER. It was `bg-muted/50` alone and read as nothing
// at all in light mode. `error` gets away with a bare fill because `--destructive`
// is CHROMATIC — `bg-destructive/10` is pink on white, which the eye catches at
// any lightness. `--muted` is `oklch(0.97 0 0)`, achromatic and three points off
// the background, so no opacity makes it register; it can only become a darker
// grey (and going DOWN — /25 — makes it lighter still, which is the trap). Full
// `bg-muted` doubles the delta to the token's designed value, and on a white
// surface the hairline is what actually delineates a block, which is why `info`
// is bordered and unfilled. Dark mode never had the problem (0.269 on 0.145) and
// the border there is `oklch(1 0 0 / 10%)`, so it only firms the edge up.
//
// `error` also carries `role="alert"`, so mounting it ANNOUNCES — the same thing
// web-ui's `FieldError` does for the auth forms. Every error tone here arrives as
// the result of a click with nothing else changing on screen, which leaves a
// screen-reader user with a button that silently re-enables and no reason why.
// The other two tones must NOT have it: they're standing text, not events.
export function SettingsNotice({
  tone = 'info',
  icon,
  className,
  children,
}: {
  tone?: 'info' | 'error' | 'pending';
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm',
        tone === 'info' && 'border border-border text-muted-foreground',
        tone === 'error' && 'bg-destructive/10 text-destructive',
        tone === 'pending' && 'border border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      {icon ? <span className={cn('mt-0.5 shrink-0')}>{icon}</span> : null}
      <span className={cn('min-w-0 flex-1')}>{children}</span>
    </p>
  );
}

// Back out of a sub-view to its section's overview. Usually reached through
// SettingsHeader's `back` prop rather than rendered directly.
export function SettingsBackLink({
  label,
  onClick,
  className,
}: {
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-ml-1 inline-flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground',
        'hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
        className,
      )}
    >
      <ChevronLeft className={cn('size-4')} />
      {label}
    </button>
  );
}
