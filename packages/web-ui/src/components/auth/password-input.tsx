'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@stxapps/web-ui/components/ui/input';
import { cn } from '@stxapps/web-ui/lib/utils';

// A password field with a show/hide reveal toggle — the typo protection the
// account model needs at create-account (there's no password reset, so a mistyped
// secret is a permanent lockout of any data encrypted under it). We deliberately
// use a reveal toggle instead of a separate "confirm password" input: same
// protection, half the typing, and it composes with the generated-passphrase path
// (docs/account.md). forwardRef + full input-props passthrough so react-hook-form's
// register() (which supplies ref/name/onChange/onBlur) works unchanged.
export const PasswordInput = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  function PasswordInput({ className, ...props }, ref) {
    const [show, setShow] = React.useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={show ? 'text' : 'password'}
          className={cn('pr-10', className)}
          {...props}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          // tabIndex -1: keep it out of the tab order so Tab goes field→submit, not
          // field→eye. aria-label + aria-pressed keep it accessible to SR users.
          tabIndex={-1}
          aria-label={show ? 'Hide password' : 'Show password'}
          aria-pressed={show}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
        >
          {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    );
  },
);
