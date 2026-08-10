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

    Function("close") {
      val activity = appContext.currentActivity
      if (activity is ShareActivity) activity.finish()
    }
  }
}
