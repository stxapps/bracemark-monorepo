import { cn } from '@stxapps/web-ui/lib/utils';

// The handful of inline glyphs shared across pages.
//
// Inline SVG rather than an icon package on purpose: the marketing site's whole
// dependency budget is `shared` + `web-ui` (docs/architecture.md, _apps_), and a
// check mark and an arrow do not earn lucide-react on the apex. Anything used by
// exactly one page stays in that page instead of landing here.
//
// All of them inherit `currentColor` and take a `className`, so colour and size
// are the caller's business.

export function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={cn(className)}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 10.5 8 14.5 16 5.5" />
    </svg>
  );
}

export function ArrowGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={cn(className)}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 10h12M11 5l5 5-5 5" />
    </svg>
  );
}

// The disclosure chevron on the FAQ. Rotates via the parent `<details>`' open
// state — see the `group-open:` rule at the call site.
export function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={cn(className)}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 7 6 6 6-6" />
    </svg>
  );
}
