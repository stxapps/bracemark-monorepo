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

import { useTheme } from '../../components/theme-provider';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Text } from '../../components/ui/text';

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

      {/* Mirrors the Input this replaced — same width, same left-aligned text —
          so the custom-mode block keeps the shape web's two time inputs have. */}
      <Button
        variant="outline"
        onPress={open}
        className="w-36 justify-start"
        aria-label={`${label}, ${formatForDisplay(value)}`}
      >
        <Text className="text-base">{formatForDisplay(value)}</Text>
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
