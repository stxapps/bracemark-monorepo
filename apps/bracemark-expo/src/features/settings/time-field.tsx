// The crossover-time control for `custom` theme mode — a button showing the
// time, which opens the PLATFORM's native time picker. This is the RN
// equivalent of bracemark-web's `<Input type="time">`: there the browser owns
// the picker and only ever emits a complete "HH:mm"; here the native dialog
// does. docs/theme.md is canonical for the ThemeState model.
//
// "Only ever emits a complete value" is the whole point, not a nicety. The
// times are validated at the READ edge — `coerceThemeState` (@stxapps/shared)
// tests /^([01]\d|2[0-3]):[0-5]\d$/ and falls back to DEFAULT_THEME on a miss,
// and `useSettings` runs both sources through it. So a free-text field is
// unusable by construction: every intermediate keystroke ("0", "06:", "1") is
// invalid, gets coerced away on the next read, and snaps the field back to
// 06:00 before the user can finish typing. It would also fire one
// writeSettingsGeneral + sync kick PER KEYSTROKE on the Sync tab. A picker
// commits exactly once, with a value that is valid by construction.
//
// 12h vs 24h is the device's, on both halves, for free — which is why no
// `is24Hour` flag is threaded through app state here:
//   • Android — `is24Hour` is deliberately NOT passed; the dialog fragment
//     defaults it to `DateFormat.is24HourFormat(context)`, i.e. the device's own
//     "Use 24-hour format" setting, which a hardcoded value would override.
//   • iOS — the spinner follows the locale on its own.
//   • The button label goes through `toLocaleTimeString`, so it follows the
//     locale too (on Android 13+ the system 24-hour toggle rides along in the
//     locale's `hc` extension).
//
// The two platforms differ in HOW the picker presents, and that is native
// convention rather than a shortcut: Android's is an imperative dialog owning
// its own OK/Cancel (`DateTimePickerAndroid.open`), iOS's is a component, so it
// gets our Dialog and an explicit Cancel/Done pair.

import { useState } from 'react';
import { Platform, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { Clock } from 'lucide-react-native';

import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { useTheme } from '../../contexts/theme-provider';

// "HH:mm" 24h ⇄ Date, the picker's currency. `value` reaches us through
// `coerceThemeState`, so it is always a real "HH:mm" and the parse is total;
// the date part is today's and is never read back out.
function toDate(hhmm: string): Date {
  const [hours, minutes] = hhmm.split(':');
  const date = new Date();
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date;
}

function toHhMm(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatForDisplay(hhmm: string): string {
  return toDate(hhmm).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function TimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  /** "HH:mm" 24h — a `ThemeState` crossover time. */
  value: string;
  onChange: (next: string) => void;
}) {
  // iOS only: the in-flight value while the Dialog is open, so Cancel discards.
  // Non-null IS "the dialog is open" — Android never sets it.
  const [draft, setDraft] = useState<Date | null>(null);
  const { effectiveTheme } = useTheme();

  const open = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: toDate(value),
        mode: 'time',
        onChange: (event, date) => {
          // 'dismissed' (or a back press) leaves the setting alone.
          if (event.type !== 'set' || !date) return;
          onChange(toHhMm(date));
        },
      });
      return;
    }
    setDraft(toDate(value));
  };

  return (
    <View className="gap-1.5">
      <Text className="text-sm font-medium">{label}</Text>

      {/* Mirrors web's time input — the time at the left edge, a clock at the
          right, and `leading-5` from the Input this replaced — so the
          custom-mode block keeps the shape web's two time inputs have. The clock
          is what web's box is sized for: the browser draws its picker indicator
          there, and without one the same box is a third empty and reads as a
          field to type in. It is also the kit's picker-trigger shape
          (components/links/list-select.tsx: `outline`, `justify-between`, a
          muted trailing icon).

          `min-w-32` is a step under web's `w-36`, and the smallest step that
          still holds the widest 12-hour label: "12:00 AM" is ~72pt in Inter at
          1×, against the 74 this box leaves beside the icon. So at the default
          text size the two fields are the same width whatever their values —
          one step down they would each hug their own time and differ.

          A minimum, not a fixed width: the label is the locale's, and it
          scales. A fixed box has to hold the longest format at the 1.3
          font-scale ceiling, and when it can't the Text wraps to a second line
          inside a pinned height; a minimum grows instead.

          The leading is load-bearing: a bare `text-base` label's line box is
          24pt, and any box tighter than that clamps the paragraph's frame and
          takes the difference out of the descender. `09:00` has none, which is
          the only reason this site looked fine while the link editors' two
          pickers did not (list-select.tsx carries the derivation). */}
      <Button
        variant="outline"
        onPress={open}
        className="min-w-32 justify-between"
        aria-label={`${label}, ${formatForDisplay(value)}`}
      >
        <Text className="text-base leading-5">{formatForDisplay(value)}</Text>
        <Icon as={Clock} className="size-4 shrink-0 text-muted-foreground" />
      </Button>

      {draft !== null && (
        <Dialog open onOpenChange={(isOpen) => !isOpen && setDraft(null)}>
          <DialogContent className="w-full max-w-sm">
            <DialogHeader>
              <DialogTitle>{label}</DialogTitle>
            </DialogHeader>

            <DateTimePicker
              value={draft}
              mode="time"
              display="spinner"
              // The spinner is a native view, so it can't read Uniwind's CSS
              // variables — the same bind `input.tsx` does for the iOS keyboard.
              // The ThemeProvider's `Appearance` pin happens to cover this in
              // custom mode, but its header calls that a side effect rather than
              // a contract, so don't lean on it.
              themeVariant={effectiveTheme}
              onChange={(_event, date) => date && setDraft(date)}
            />

            <DialogFooter>
              <Button variant="outline" onPress={() => setDraft(null)}>
                <Text>Cancel</Text>
              </Button>
              <Button
                onPress={() => {
                  onChange(toHhMm(draft));
                  setDraft(null);
                }}
              >
                <Text>Done</Text>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </View>
  );
}
