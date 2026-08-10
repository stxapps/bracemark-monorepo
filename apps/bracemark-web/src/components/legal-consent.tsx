import { cn } from '@stxapps/web-ui/lib/utils';

import { PRIVACY_URL, TERMS_URL } from '@/lib/site';

// The consent line: "By <doing this>, you agree to our Terms of Service and
// Privacy Policy." It sits under the control that performs the act, on the two
// surfaces where an act actually binds the user to something — creating an
// account, and buying a subscription.
//
// WHY A COMPONENT for one sentence. The same two anchors, at the same register,
// with the same four styling utilities, appear on both of those surfaces, and
// bracemark-expo carries a byte-for-byte port of each. That is the AuthAltAction
// argument (see `(auth)/_components/auth-alt-action.tsx`): styling this shallow
// drifts by one class per edit until two surfaces of the same product no longer
// match. Only the verb differs, so only the verb is a prop.
//
// THE NAMES ARE THE DOCUMENTS' OWN TITLES — "Terms of Service", "Privacy Policy",
// not the "Terms" / "Privacy" the site footer and Settings → About use for their
// nav rows. Both of those are lists where the surrounding context supplies the
// noun; a consent sentence is the one place the user is agreeing to a named
// thing, and the name has to be the one at the top of the page that opens.
//
// FINE-PRINT REGISTER, deliberately: `text-xs` muted body with links carrying
// only an underline at rest. This line is not an offer to go read something, it
// is a disclosure attached to a button — styled at the `text-sm` weight of a real
// link it would compete with the CTA above it and the alt-action below it. The
// underline is the whole affordance (no accent token exists in this app — see
// auth-alt-action), hover promotes the text to `--foreground`, and the settings
// sections' own inline fine-print links already read exactly this way.
//
// NEW TAB IS LOAD-BEARING, not politeness. On /create-account the ceremony holds
// a generated passphrase and a step counter in component state; a same-tab
// navigation to the terms and a Back would hand the user a NEW passphrase and put
// them on step one, having destroyed the one they may have just saved. In
// Settings the same click would drop a live session behind a sync loop. Settings
// → About makes this argument for its external rows too.
const linkClass = cn(
  'rounded-sm underline underline-offset-2 transition-colors hover:text-foreground',
  'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
);

export function LegalConsent({
  // The verb phrase completing "By …". Name the act the button performs, not the
  // button ("creating an account", not "clicking the button above") — the label
  // under the pointer changes with the step, and the act doesn't.
  action,
  className,
}: {
  action: string;
  className?: string;
}) {
  return (
    <p className={cn('text-xs leading-5 text-muted-foreground', className)}>
      By {action}, you agree to our{' '}
      <a className={linkClass} href={TERMS_URL} target="_blank" rel="noopener noreferrer">
        Terms of Service
      </a>{' '}
      and{' '}
      <a className={linkClass} href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
        Privacy Policy
      </a>
      .
    </p>
  );
}
