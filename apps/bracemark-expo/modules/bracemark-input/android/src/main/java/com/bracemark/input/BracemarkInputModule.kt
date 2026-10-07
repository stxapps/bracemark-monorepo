package com.bracemark.input

import android.text.InputType
import android.text.TextUtils
import android.view.View
import android.widget.EditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// A single-line field's placeholder, kept to ONE line — the lever
// src/components/ui/input.tsx pulls for every field it renders.
//
// Android lays a hint out in two different widths. A measure pass gives a
// horizontally scrolling (single-line) TextView a VERY_WIDE hint, so it never
// wraps; every other path — `assumeLayout()`, which rebuilds a nulled layout at
// draw time — gives it the view's PHYSICAL width, and it wraps. Under Fabric
// the second path is the common one: React Native's EditText carries
// WRAP_CONTENT layout params, so `setHint` and `setText` take TextView's
// "we lose" branch (`nullLayouts()` + `requestLayout()`), and nothing answers
// that request with a measure while the field's frame is unchanged. So the
// placeholder mounts on one line, clipped, and wraps onto a second line the
// field cuts in half the first time it changes or the field is typed in and
// cleared.
//
// An ellipsize mode is the one thing both paths agree on: with one set the
// hint is laid out wide and truncated to the physical width, whichever path
// built it. It does not touch what is TYPED — TextView ellipsizes the text
// itself only when there is no key listener, and an editable field has one.
//
// This is React Native's own fix (ReactEditText.updatePlaceholderEllipsize,
// 0.88), reached from outside because 0.81 has no prop for it. The multiline
// branch is upstream's too: a field that wraps on purpose must not truncate.
class BracemarkInputModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BracemarkInput")

    // On the main queue: resolving a view by its tag is a UI-thread read. A tag
    // that resolves to nothing (the field unmounted first) is not an error.
    AsyncFunction("ellipsizePlaceholder") { viewTag: Int ->
      val field = appContext.findView<View>(viewTag) as? EditText
      if (field != null) {
        val multiline = (field.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0
        field.ellipsize = if (multiline) null else TextUtils.TruncateAt.END
      }
    }.runOnQueue(Queues.MAIN)
  }
}
