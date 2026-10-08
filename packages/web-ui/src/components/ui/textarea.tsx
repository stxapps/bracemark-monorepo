import * as React from 'react';

import { cn } from '@stxapps/web-ui/lib/utils';

// `text-base` below `md` — the control type step; input.tsx carries the reasoning.
// `autoComplete="off"` by default for input.tsx's reason too: a note is the
// user's content, and the attribute is also what tells a browser not to keep a
// field's value with the page it restores.
// Notes are prose: sentence capitalization and spelling assistance are useful
// even though the browser should not autofill them. Callers editing exact text
// can override each hint (docs/editors.md, _typing assistance_).
function Textarea({
  className,
  autoComplete = 'off',
  autoCapitalize = 'sentences',
  autoCorrect = 'on',
  spellCheck = true,
  ...props
}: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      autoComplete={autoComplete}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      spellCheck={spellCheck}
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full resize-none rounded-xl border border-input bg-input/30 px-3 py-3 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-[3px] aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
