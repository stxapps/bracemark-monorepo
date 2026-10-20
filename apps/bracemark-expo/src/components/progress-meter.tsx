import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { withUniwind } from 'uniwind';

import { progressPercent } from '@stxapps/shared';

import { cn } from '../lib/utils';
import { Text } from './ui/text';

// The expo port of web-ui's components/progress-meter.tsx (the canonical doc —
// why a bar plus TWO numbers, the count and the percent, and why the
// progressbar must not be a live region). The first-sync gate and the Data
// card's cycle readout both render it, so a sync looks the same wherever it is
// watched, on either app.
//
// Two divergences, both platform:
//
//  - The glide is Reanimated, not a class. Uniwind passes `transitionProperty`
//    through and RN 0.81 ignores it (ui/switch.tsx has the specimen), so a
//    `transition-*` class here would type-check and snap. The fill is a shared
//    value eased with `withTiming` — linear, the curve for constant motion, over
//    two of the callers' 100 ms repaints, so it is still moving when the next
//    value lands and never visibly stops. Its `width` is animated rather than a
//    transform because the fill is absolutely positioned and childless — nothing
//    re-lays-out around it — and width keeps the rounded end that a scaleX would
//    smear. `ReduceMotion.System` makes the step instant under the OS setting:
//    the value still updates, only the glide goes.
//  - No indeterminate drawing. Native expects a spinner where web is happy with
//    a pulsing track, so a caller with no number yet renders an
//    ActivityIndicator instead (initial-sync-gate.tsx). A non-positive total
//    still draws safely — an empty track claiming no value — because this is a
//    package boundary away from the engine's "total ≥ 1".
const FILL_MS = 200;

// Reanimated's View is a third-party component to uniwind, so its className goes
// through the wrapper (link-add-panel.tsx does the same for Animated.ScrollView).
const StyledAnimatedView = withUniwind(Animated.View);

export function ProgressMeter({
  label,
  done,
  total,
  valueText,
  className,
}: {
  // The progressbar's accessible name — what the job is.
  label: string;
  done: number;
  total: number;
  // The visible count line, and the progressbar's `aria-valuetext`.
  valueText: string;
  className?: string;
}) {
  const determinate = total > 0;
  const percent = progressPercent(done, total);
  // The fill takes the exact fraction, the text the floored percent: the bar may
  // creep within a percent, the number may not claim 100 before the last unit.
  const fraction = determinate ? Math.max(0, Math.min(1, done / total)) : 0;

  const fill = useSharedValue(fraction);
  useEffect(() => {
    fill.set(
      withTiming(fraction, {
        duration: FILL_MS,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [fill, fraction]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.get() * 100}%` }));

  return (
    <View className={cn('w-full gap-1.5', className)}>
      {/*
        `role` + the four `aria-value*` props are the RN-supported spelling — they
        reach VoiceOver and TalkBack (docs/accessibility.md, the note on
        ARIA-shaped props). NOT a live region: it repaints ten times a second.
      */}
      <View
        role="progressbar"
        aria-label={label}
        {...(determinate
          ? {
              'aria-valuemin': 0,
              'aria-valuemax': total,
              'aria-valuenow': done,
              'aria-valuetext': valueText,
            }
          : {})}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {determinate && (
          <StyledAnimatedView
            className="absolute top-0 bottom-0 left-0 rounded-full bg-primary"
            style={fillStyle}
          />
        )}
      </View>
      {/*
        Hidden from assistive tech because the progressbar already announces the
        count as its value. ⚠ The wrapping View is load-bearing: `aria-hidden` on
        a Text does nothing on RN (docs/accessibility.md, _the first-sync
        counter_ — the per-component list of fourteen).
      */}
      <View aria-hidden className="flex-row items-baseline justify-between gap-3">
        <Text
          className="min-w-0 flex-1 text-xs text-muted-foreground tabular-nums"
          numberOfLines={1}
        >
          {valueText}
        </Text>
        {determinate && (
          <Text className="text-xs text-muted-foreground tabular-nums">{percent}%</Text>
        )}
      </View>
    </View>
  );
}
