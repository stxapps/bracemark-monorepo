import { cn } from '@stxapps/web-ui/lib/utils';

// The one definition of a published address on this site. It was a local
// component in content/faq.tsx plus six hand-copied class strings, and the copies
// had drifted in the way copies do: three of the seven carried no focus ring at
// all. That is invisible to a mouse and is the entire affordance for a keyboard,
// which is why it was worth one component rather than a tidy-up.
//
// TWO REGISTERS, and the variant picks between them rather than expressing a
// preference. `prose` is the body face, for an address inside a sentence on a
// page written for a reader — /about, the FAQ. `specimen` is IBM Plex Mono, for a
// page written for someone who is going to PASTE the string: /extractor's
// sysadmin, an error page, the footer, /support's standalone target. There the
// address sits beside a user-agent line, a status code or a config snippet and is
// a literal like they are.
//
// `prose` is the default deliberately. A new call site is usually a sentence, and
// mono in a paragraph steps the x-height mid-line — the /about paragraph carried
// exactly that for a while, reading as a caption that had fallen into the text.
//
// Layout, size and colour stay at the call site via `className`: cn() is
// tailwind-merge, so `text-xl`, `underline-offset-8`, `text-signal-strong` and
// the footer's `ring-offset-2` beat the base instead of fighting it.
//
// NOT USED BY /privacy AND /terms, and that is not an omission. Those documents
// are plain h2/p/ol under `.legal-prose` (globals.css) so the markup stays
// readable as prose, and `.legal-prose a` already paints this exact link — a
// component here would give their addresses a treatment the links around them
// don't have.
export function MailLink({
  address,
  variant = 'prose',
  className,
}: {
  address: string;
  variant?: 'prose' | 'specimen';
  className?: string;
}) {
  return (
    <a
      className={cn(
        'rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        variant === 'specimen' && 'font-mono',
        className,
      )}
      href={`mailto:${address}`}
    >
      {address}
    </a>
  );
}
