import { useEffect, useMemo, useState } from 'react';
import { type AccessibilityActionEvent, BackHandler, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { Image } from 'expo-image';
import { X } from 'lucide-react-native';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import {
  NativeOnlyAnimatedView,
  POPUP_FADE_MS,
} from '../../components/ui/native-only-animated-view';

// The screenshot, full screen, to zoom — opened by a tap on the reader's screenshot
// (reader-screen.tsx). The capture is a desktop viewport, ~1500 CSS px wide, so fitted
// to a phone's column its text is drawn at about a quarter of its size: this is where
// it gets read (docs/reader.md, _the screenshot_).
//
// ⚠ DRAWN IN THE READER'S OWN TREE, NOT A `Modal` AND NOT A PORTAL. A react-native
// Modal is its own window on Android, and the root PortalHost sits outside
// AppLockGate's hidden wrapper; either would leave the page's picture up over the lock
// pane after a relock (docs/locks.md, _overlays over a relock_; the lint fence in
// eslint.config.mjs). As a sibling of the reader's content it is hidden with the
// rest of the app, and it unmounts the moment the reader stops showing this
// screenshot — a list lock, or a delete from another device.
//
// The gestures are the platform photo viewer's: pinch about the fingers, drag when
// zoomed (flung, and held at the edges), double-tap to zoom in at the tap or back out.
// Every one runs on the UI thread; the only crossing to React is the zoom level, once
// per gesture end, for the screen reader's value. VoiceOver and TalkBack can't pinch,
// so the picture is `adjustable`: swipe up or down zooms about the middle.

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
// How far past the edge a drag follows the finger, as a fraction of its movement.
const RUBBER = 0.3;
// expo-animation's table: a settle with no overshoot (double-tap, the screen-reader
// steps), and a snap back after a drag.
const SETTLE = { duration: 400, dampingRatio: 1, reduceMotion: ReduceMotion.System } as const;
const SNAP = { duration: 400, dampingRatio: 0.8, reduceMotion: ReduceMotion.System } as const;
const FADE_IN = FadeIn.duration(POPUP_FADE_MS).reduceMotion(ReduceMotion.System);
const FADE_OUT = FadeOut.duration(POPUP_FADE_MS).reduceMotion(ReduceMotion.System);

function clamp(v: number, lo: number, hi: number): number {
  'worklet';
  return Math.min(hi, Math.max(lo, v));
}

// How far the image's centre may move from the box's on one axis, at `scale`: zero
// until the scaled image overflows the box, then half the overflow.
function reach(size: number, box: number, scale: number): number {
  'worklet';
  return Math.max(0, (size * scale - box) / 2);
}

export function ScreenshotViewer({
  uri,
  ratio,
  label,
  onClose,
}: {
  uri: string;
  // width / height of the image, read off its load in the reader.
  ratio: number;
  label: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [box, setBox] = useState({ width: 0, height: 0 });
  // The zoom as React knows it — only for `accessibilityValue`, set at gesture ends.
  const [level, setLevel] = useState(1);

  // Centred in the whole window (the gesture maths takes the box's centre as the
  // image's) and fitted inside the safe area, so at rest nothing sits under the notch
  // or the home indicator. The larger inset of each pair, on both sides, is what keeps
  // a centred image clear of both; zoomed, it pans across the whole window.
  const availW = Math.max(0, box.width - 2 * Math.max(insets.left, insets.right));
  const availH = Math.max(0, box.height - 2 * Math.max(insets.top, insets.bottom));
  const fitW = availW / availH > ratio ? availH * ratio : availW;
  const fitH = fitW / ratio;
  const boxW = box.width;
  const boxH = box.height;

  const scale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const start = useSharedValue({ scale: 1, x: 0, y: 0, fx: 0, fy: 0 });
  const pinching = useSharedValue(false);
  const lastPan = useSharedValue({ x: 0, y: 0 });

  // Android's back closes the viewer, not the reader under it — BackHandler runs
  // its listeners newest-first.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const gesture = useMemo(() => {
    // Animates to `s` (kept within 1…MAX) and an offset kept within its reach there.
    // Returns the scale it lands on.
    const settle = (s: number, x: number, y: number, config: typeof SETTLE | typeof SNAP) => {
      'worklet';
      const to = clamp(s, 1, MAX_SCALE);
      const rx = reach(fitW, boxW, to);
      const ry = reach(fitH, boxH, to);
      scale.set(withSpring(to, config));
      tx.set(withSpring(clamp(x, -rx, rx), config));
      ty.set(withSpring(clamp(y, -ry, ry), config));
      return to;
    };

    // The point under the fingers stays under them: a point `p` of the image (from
    // its centre, unscaled) is drawn at `t + p·s`, so holding it where the focal
    // point now is gives `t = f − (f₀ − t₀)·s/s₀`. Moving fingers pan, too.
    const pinch = Gesture.Pinch()
      .onStart((e) => {
        pinching.set(true);
        start.set({
          scale: scale.get(),
          x: tx.get(),
          y: ty.get(),
          fx: e.focalX - boxW / 2,
          fy: e.focalY - boxH / 2,
        });
      })
      .onUpdate((e) => {
        const s0 = start.get();
        // A little past either limit while the fingers are down; the end settles it.
        const s = clamp(s0.scale * e.scale, 0.5, MAX_SCALE * 1.5);
        const k = s / s0.scale;
        scale.set(s);
        tx.set(e.focalX - boxW / 2 - (s0.fx - s0.x) * k);
        ty.set(e.focalY - boxH / 2 - (s0.fy - s0.y) * k);
      })
      .onEnd(() => {
        scheduleOnRN(setLevel, settle(scale.get(), tx.get(), ty.get(), SNAP));
      })
      .onFinalize(() => {
        pinching.set(false);
      });

    // By the change since the last update rather than the gesture's total, so a pinch
    // that ends with one finger still down hands over without a jump.
    const pan = Gesture.Pan()
      .onStart((e) => {
        lastPan.set({ x: e.translationX, y: e.translationY });
      })
      .onUpdate((e) => {
        const last = lastPan.get();
        const dx = e.translationX - last.x;
        const dy = e.translationY - last.y;
        lastPan.set({ x: e.translationX, y: e.translationY });
        if (pinching.get()) return;
        const s = scale.get();
        const rx = reach(fitW, boxW, s);
        const ry = reach(fitH, boxH, s);
        const x = tx.get();
        const y = ty.get();
        const outX = (x >= rx && dx > 0) || (x <= -rx && dx < 0);
        const outY = (y >= ry && dy > 0) || (y <= -ry && dy < 0);
        tx.set(x + (outX ? dx * RUBBER : dx));
        ty.set(y + (outY ? dy * RUBBER : dy));
      })
      .onEnd((e) => {
        if (pinching.get()) return;
        const s = scale.get();
        const rx = reach(fitW, boxW, s);
        const ry = reach(fitH, boxH, s);
        const x = tx.get();
        const y = ty.get();
        // Past an edge (or not zoomed at all): back inside. Inside: flung, and
        // stopped at the edges.
        if (s <= 1 || Math.abs(x) > rx || Math.abs(y) > ry) {
          settle(s, x, y, SNAP);
          return;
        }
        tx.set(
          withDecay({
            velocity: e.velocityX,
            clamp: [-rx, rx],
            reduceMotion: ReduceMotion.System,
          }),
        );
        ty.set(
          withDecay({
            velocity: e.velocityY,
            clamp: [-ry, ry],
            reduceMotion: ReduceMotion.System,
          }),
        );
      });

    const doubleTap = Gesture.Tap()
      .numberOfTaps(2)
      .onEnd((e, success) => {
        if (!success) return;
        if (scale.get() > 1.01) {
          scheduleOnRN(setLevel, settle(1, 0, 0, SETTLE));
          return;
        }
        // In at the tap: from rest (t = 0, s = 1) the pinch's rule gives t = f − f·s.
        const fx = e.x - boxW / 2;
        const fy = e.y - boxH / 2;
        const s = DOUBLE_TAP_SCALE;
        scheduleOnRN(setLevel, settle(s, fx - fx * s, fy - fy * s, SETTLE));
      });

    return Gesture.Simultaneous(pinch, pan, doubleTap);
  }, [boxW, boxH, fitW, fitH, scale, tx, ty, start, pinching, lastPan]);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: scale.get() }],
  }));

  // The screen reader's zoom: steps of 1.5× about the middle of what is in view.
  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    const factor = e.nativeEvent.actionName === 'increment' ? 1.5 : 1 / 1.5;
    const from = scale.get();
    const to = clamp(from * factor, 1, MAX_SCALE);
    const k = to / from;
    const rx = reach(fitW, boxW, to);
    const ry = reach(fitH, boxH, to);
    scale.set(withSpring(to, SETTLE));
    tx.set(withSpring(clamp(tx.get() * k, -rx, rx), SETTLE));
    ty.set(withSpring(clamp(ty.get() * k, -ry, ry), SETTLE));
    setLevel(to);
  };

  return (
    // `accessibilityViewIsModal` keeps VoiceOver in here; the reader hides its own
    // content for TalkBack (reader-screen.tsx). docs/accessibility.md, _modality_.
    <NativeOnlyAnimatedView
      entering={FADE_IN}
      exiting={FADE_OUT}
      accessibilityViewIsModal
      className="absolute inset-0 bg-background"
    >
      <GestureDetector gesture={gesture}>
        <View
          collapsable={false}
          className="flex-1 items-center justify-center overflow-hidden"
          onLayout={(e) =>
            setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
          }
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={label}
          accessibilityValue={{ text: `${Math.round(level * 100)}%` }}
          accessibilityActions={[
            { name: 'increment', label: 'Zoom in' },
            { name: 'decrement', label: 'Zoom out' },
          ]}
          onAccessibilityAction={onAccessibilityAction}
        >
          {fitW > 0 && fitH > 0 ? (
            <Animated.View style={[{ width: fitW, height: fitH }, imageStyle]}>
              <Image
                source={{ uri }}
                contentFit="contain"
                // Decoded at full size, not the view's: the zoom is a transform, so a
                // bitmap downscaled to the fitted box would blur at every zoom.
                allowDownscaling={false}
                // Never the default ('disk'), which writes a second plaintext copy into
                // the module's own cache, out of sign-out's reach. And no memory entry:
                // this is the one full-resolution decode, opened on purpose, and nothing
                // reads it back once the viewer closes. docs/expo-dependencies.md, expo-image.
                cachePolicy="none"
                style={{ width: '100%', height: '100%' }}
              />
            </Animated.View>
          ) : null}
        </View>
      </GestureDetector>
      {/* The floating tier's close: the kit's 36 box and `size-4` glyph, the sheet's
          plain 8 of slop with nothing pressable near it (docs/accessibility.md,
          _a 36dp box is not a 44pt target_). Filled, since it floats over a picture. */}
      <Button
        variant="secondary"
        size="icon-sm"
        className="absolute"
        style={{ top: insets.top + 8, right: insets.right + 8 }}
        hitSlop={8}
        accessibilityLabel="Close screenshot"
        testID="reader-screenshot-close"
        onPress={onClose}
      >
        <Icon as={X} className="size-4 text-secondary-foreground" />
      </Button>
    </NativeOnlyAnimatedView>
  );
}
