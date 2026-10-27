// Measurement bundles only: the JS-thread stall probe's surfaces (expo-react
// lib/stall-probe.ts). Every export here renders nothing in any other build,
// where the probe was never started — `useStallProbe()` is null there — so a
// shipped app carries the code and never draws it.
//
// The runner reads the probe back as TEXT off the accessibility tree (e2e/
// measure/native.ts, `readProbe`): the readout below is the only channel out of
// the app it has. The data path's windows are opened by the import and export
// hooks themselves; the render leg has no run to hang one on, so the links
// screen carries a pair of controls that open and close it around the gestures
// (docs/e2e.md, _the render leg_).

import { Pressable, View } from 'react-native';

import { beginStallWindow, endStallWindow, useStallProbe } from '@stxapps/expo-react';

import { cn } from '../lib/utils';
import { Text } from './ui/text';

// The labels the render leg opens a window under. A reading carries its label,
// and the runner refuses one that isn't the leg it just ran — a stale reading
// from the leg before reads exactly like a fresh one otherwise.
const RENDER_WINDOWS = ['scroll', 'rail'] as const;

export function StallReadout({ className }: { className?: string }) {
  const probe = useStallProbe();
  if (probe === null) return null;
  return (
    <Text testID="measure-stall-reading" className={cn('text-xs text-muted-foreground', className)}>
      {JSON.stringify(probe)}
    </Text>
  );
}

// The render leg's window controls and its readout, floated in the links
// screen's bottom-leading corner: clear of the FAB (trailing) and of the swipe
// path down the middle, so no gesture the leg makes lands on them.
// `pointerEvents="box-none"` lets a touch beside the controls reach the list.
export function RenderMeasureControls() {
  const probe = useStallProbe();
  if (probe === null) return null;
  return (
    <View pointerEvents="box-none" className="absolute bottom-2 left-2 max-w-[45%] gap-1">
      <StallReadout className="bg-background text-[8px]" />
      <View className="flex-row gap-1">
        {RENDER_WINDOWS.map((label) => (
          <Pressable
            key={label}
            testID={`measure-begin-${label}`}
            onPress={() => beginStallWindow(label)}
            className="rounded bg-muted px-2 py-1"
          >
            <Text className="text-[10px]">{label}</Text>
          </Pressable>
        ))}
        <Pressable
          testID="measure-end"
          onPress={endStallWindow}
          className="rounded bg-muted px-2 py-1"
        >
          <Text className="text-[10px]">end</Text>
        </Pressable>
      </View>
    </View>
  );
}
