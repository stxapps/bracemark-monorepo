import { Platform } from 'react-native';

// `scrollsToTop` for the scrollers that sit under a top bar: iOS's tap-the-status-
// bar scroll-to-top, OFF on an iPad.
//
// On an iPad the region iOS treats as the status bar reaches far below the status
// bar itself, over the upper half of every top bar we draw. Measured on the iPad
// Pro 11" (M5) simulator, iPadOS 26, upright: a tap at y ≤ 62 scrolled the links
// list to the top, at y ≥ 65 it did not, while the status bar is 24 tall and the
// top bars' buttons span y 41–77. So the upper half of the search button, the ⋯,
// the rail's hide button or the reader's ✕ is ALSO a status-bar tap — our
// Pressables are not UIControls, so iOS doesn't see the touch as taken. It acts
// about 350 ms later, which is how closing the reader or the capture screen
// brought the user back to the TOP of the links list: by then the reader was gone
// and the list under it was the scroller in front. Gating on focus could not catch
// that (the list is focused again before iOS acts).
//
// An iPhone's status bar is taller than that region, so its top bars sit below it
// and keep the gesture. Android has no such gesture, and the prop does nothing there.
export const SCROLLS_TO_TOP = !(Platform.OS === 'ios' && Platform.isPad);
