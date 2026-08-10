package com.bracemark.share

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

// The Android share target (docs/share-sheet.md): a translucent activity in
// the app's own process that mounts the 'bracemarkShare' RN root (registered in
// index.js) as a bottom sheet OVER the calling app. Because it runs in-process
// it shares the warm React host with the main activity — and, crucially, the
// intent payload is read here in the delegate and handed to the root as its
// initial props, so it can never be lost to a sleeping main activity (the
// expo-share-intent failure mode this design replaces).
//
// Deliberately a PLAIN DefaultReactActivityDelegate, not expo's
// ReactActivityDelegateWrapper: the wrapper exists to dispatch
// activity-lifecycle listeners for modules like expo-splash-screen, none of
// which apply to this transient sheet.
class ShareActivity : ReactActivity() {
  override fun getMainComponentName(): String = "bracemarkShare"

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
      // The ACTION_SEND payload → the share root's initial props: `text` is
      // EXTRA_TEXT (the URL, sometimes wrapped in prose by Chrome), `subject`
      // is EXTRA_SUBJECT (often the page title). Parsing/normalizing is the JS
      // side's job (share-url.ts) so both platforms share it.
      override fun getLaunchOptions(): Bundle {
        val props = Bundle()
        val intent = this@ShareActivity.intent
        if (intent?.action == Intent.ACTION_SEND) {
          intent.getStringExtra(Intent.EXTRA_TEXT)?.let { props.putString("text", it) }
          intent.getStringExtra(Intent.EXTRA_SUBJECT)?.let { props.putString("subject", it) }
        }
        return props
      }
    }
  }
}
