package com.bracemark.share

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The share sheet's one JS-callable control: dismiss the ShareActivity
// (share-host.ts's Android half — iOS uses expo-share-extension's close()).
// Guarded to the ShareActivity so a stray call from the main app can never
// finish the wrong activity.
class BracemarkShareModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BracemarkShare")

    // A synchronous Function runs on the JS thread, and an Activity is the UI
    // thread's to finish — hence the hop, rather than an AsyncFunction on the
    // main queue, which would hand share-host.ts a promise nothing awaits.
    Function("close") {
      val activity = appContext.currentActivity
      if (activity is ShareActivity) activity.runOnUiThread { activity.finish() }
    }
  }
}
