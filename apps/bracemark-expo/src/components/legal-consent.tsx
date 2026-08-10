import { Linking } from 'react-native';

import { PRIVACY_URL, TERMS_URL } from '../lib/site';
import { cn } from '../lib/utils';
import { Text } from './ui/text';

// The consent line — the RN port of bracemark-web's `components/legal-consent.tsx`,
// sentence for sentence. Read that file for why it is a component rather than a
// typed sentence, why the links carry the documents' full titles, and why the
// register is fine print rather than a `text-sm` link. This one records only what
// native does differently.
//
// IT OPENS THE SYSTEM BROWSER (`Linking.openURL`), which backgrounds this app
// instead of opening a tab beside it — the same trade Settings → About makes for
// its external rows. The state worry that makes `target="_blank"` load-bearing on
// web does not arise here: backgrounding does not unmount, so a user who reads the
// terms mid-ceremony comes back to the same step holding the same passphrase.
//
// THE LINK IS A `Text` WITH `onPress`, not a Pressable wrapping a Text. An inline
// link has to flow WITH the sentence, and a Pressable is a View, which on Android
// cannot be nested inside text at all — the same RN idiom, and the same reason,
// as auth-alt-action.tsx. The touch target is therefore the words themselves,
// which is also why the size class is repeated on each link: nested RN text does
// not inherit the parent's utilities.
//
// NO HOVER PROMOTION, unlike web's, because there is no pointer to promote on.
// That leaves the underline carrying the affordance alone, which is what web
// shows at rest anyway — so the two platforms read identically, which is the
// whole point of porting rather than re-designing.
const linkClass = 'text-xs underline';

export function LegalConsent({
  // The verb phrase completing "By …". Name the act the button performs, not the
  // button — the label under the thumb changes with the step, and the act doesn't.
  action,
  className,
}: {
  action: string;
  className?: string;
}) {
  return (
    <Text className={cn('text-xs leading-5 text-muted-foreground', className)}>
      By {action}, you agree to our{' '}
      <Text
        onPress={() => void Linking.openURL(TERMS_URL)}
        accessibilityRole="link"
        className={linkClass}
      >
        Terms of Service
      </Text>{' '}
      and{' '}
      <Text
        onPress={() => void Linking.openURL(PRIVACY_URL)}
        accessibilityRole="link"
        className={linkClass}
      >
        Privacy Policy
      </Text>
      .
    </Text>
  );
}
