'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { Input } from '@stxapps/web-ui/components/ui/input';
import { cn } from '@stxapps/web-ui/lib/utils';

// A password field with a show/hide reveal toggle — the typo protection the
// account model needs at create-account (there's no password reset, so a mistyped
// secret is a permanent lockout of any data encrypted under it). We deliberately
// use a reveal toggle instead of a separate "confirm password" input: same
// protection, half the typing, and it composes with the generated-passphrase path.
// This is the ONLY spelling of a secret field on either platform — auth forms,
// settings, delete-account and both lock surfaces alike — so callers must NOT pass
// `type="password"`: `{...props}` spreads last and would win, leaving the eye
// toggling nothing (docs/account.md, _every field that takes a secret reveals it_).
// forwardRef + full input-props passthrough so react-hook-form's register() (which
// supplies ref/name/onChange/onBlur) works unchanged.
//
// `onShownChange` IS FOR A VALUE LONGER THAN THE FIELD: its host shows the whole thing
// elsewhere. Seven generated words run to about 45 characters and the field shows
// about 30 on a phone, so create-account shows them in a box under the field. ⚠ The
// field itself must stay this one `<input>`, and the reveal only flips its `type`.
// It used to become a `<textarea>` while shown, which unmounted a filled password
// field on every press of the eye: focus and caret went, the layout jumped, the ref
// went null, and a manager can read a filled password field going away as a
// submission. iOS did exactly that to the native twin, raising "Save Password?"
// before any account existed (docs/account.md, _every field that takes a secret
// reveals it_).
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & { onShownChange?: (shown: boolean) => void }
>(function PasswordInput({ className, onShownChange, ...props }, ref) {
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
        onClick={() => {
          setShow(!show);
          onShownChange?.(!show);
        }}
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
});
