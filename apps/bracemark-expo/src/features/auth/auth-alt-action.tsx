import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Text } from '../../components/ui/text';

// The door to the OTHER auth screen, docked at the bottom of the card — the RN
// port of bracemark-web's `(auth)/_components/auth-alt-action.tsx`. Both screens
// carry one, pointing at each other, and it lives here rather than being typed
// twice because the styling is six utilities deep: the kind that drifts by one
// class per edit until the two screens no longer match.
//
// THE RULE IS DOING WORK, not decorating. On /sign-in this line lands directly
// under the form's own "Forgot your password? Use a recovery code", and the two
// are the same size, the same muted colour and both underlined — a stack of two
// look-alike links where one stays on this screen and the other leaves it. The
// hairline says which is which: everything above it acts on the form you are
// looking at, the line below it goes somewhere else. Full-bleed (`-mx-6 px-6`
// against DogEaredCard's 24px inset) so it reads as the card's own division
// rather than a short stroke floating in the padding.
//
// The link is `text-foreground` + underline rather than a colour: there is no
// accent token, and in the light theme `--primary` is very nearly the body
// colour, so a "link" set in it reads as plain bold text with no affordance.
//
// `router.replace`, not `push`: these two screens are peers, not a stack. Web
// gets this free — its two routes swap the card's contents under one layout —
// whereas pushing here would let three taps build /sign-in → /create-account →
// /sign-in and leave Android's back button walking that ladder down.
//
// The action is a `Text` with `onPress`, not a Pressable wrapping a Text: an
// inline link has to flow WITH the sentence, and a Pressable is a View, which on
// Android cannot be nested inside text at all. This is the RN idiom, and it is
// why the touch target is the words rather than a padded box.
export function AuthAltAction({
  // The question, e.g. "New to Bracemark?".
  prompt,
  href,
  // The link text. Name it exactly as the screen it opens is titled, so the
  // destination is never a surprise.
  action,
}: {
  prompt: string;
  href: '/sign-in' | '/create-account';
  action: string;
}) {
  const router = useRouter();

  return (
    <View className="-mx-6 mt-6 -mb-6 border-t border-border px-6 py-6">
      <Text className="text-sm text-muted-foreground">
        {prompt}{' '}
        <Text
          onPress={() => router.replace(href)}
          accessibilityRole="link"
          className="text-sm font-medium text-foreground underline"
        >
          {action}
        </Text>
      </Text>
    </View>
  );
}
