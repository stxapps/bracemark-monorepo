package com.bracemark.share

import android.app.ActivityManager
import android.content.Context
import android.os.Debug
import android.os.Process
import android.os.SystemClock
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// THE SHARE SHEET'S MEMORY ON ANDROID, READ FROM INSIDE THE APP'S PROCESS.
//
// The iOS twin (ios/BracemarkShareMemoryModule.swift) watches a hard per-process
// cap that the share extension lives under. Android has no such cap for the
// sheet: ShareActivity runs in the APP's process, so its limits are the app's —
// the Java heap's ceiling (`Runtime.maxMemory()`, an OutOfMemoryError past it),
// and the low-memory killer, which picks processes by their PSS and importance
// when the device runs short. So the line logs what those two act on:
//
//   - `pss` — the process's proportional set size, what the LMK and
//     `dumpsys meminfo` rank it by, with its Java, native and graphics parts;
//   - `java` — the Java heap in use against its ceiling (`maxMemory`), and the
//     device's `memoryClass` — the per-app heap budget — for the device at hand;
//
// then the same tail as iOS (share-memory.ts): the Hermes heap and the process's
// age, which on Android also says whether the sheet found the app's process
// already warm or started it cold.
//
// `mark(label, stats)` writes it to logcat at INFO under the tag `share-memory`
// (`adb logcat -s share-memory`), in every build. `Debug.getMemoryInfo` walks the
// process's own maps — a few milliseconds, once per screen as it mounts, on the
// JS thread — and is not rate-limited the way ActivityManager's per-pid query is.
// Numbers only: no URL, no title, nothing of the share.
class BracemarkShareMemoryModule : Module() {
  override fun definition() = ModuleDefinition {
    // The name is part of the JS contract (share-memory.ts), and the iOS module's.
    Name("BracemarkShareMemory")

    Function("mark") { label: String, stats: Map<String, Double> ->
      val info = Debug.MemoryInfo()
      Debug.getMemoryInfo(info)
      val runtime = Runtime.getRuntime()
      val javaUsed = runtime.totalMemory() - runtime.freeMemory()
      val memoryClass = (appContext.reactContext?.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager)
        ?.memoryClass

      val parts = mutableListOf(
        "pss ${mb(info.totalPss * 1024L)} MB" +
          " (java ${statMb(info, "summary.java-heap")}, native ${statMb(info, "summary.native-heap")}," +
          " graphics ${statMb(info, "summary.graphics")})",
        "java ${mb(javaUsed)}/${mb(runtime.maxMemory())} MB" + (memoryClass?.let { ", class $it MB" } ?: ""),
      )
      val used = stats["jsAllocated"]
      val heap = stats["jsHeap"]
      if (used != null && heap != null) parts.add("js ${mb(used.toLong())}/${mb(heap.toLong())} MB")
      stats["jsMalloc"]?.let { parts.add("js-ext ${mb(it.toLong())} MB") }
      stats["gcs"]?.let { parts.add("gcs ${it.toInt()}") }
      val ageMs = SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()
      parts.add("age ${"%.1f".format(ageMs / 1000.0)} s")

      Log.i(TAG, "share-memory $label: ${parts.joinToString(", ")}")
    }
  }

  private companion object {
    const val TAG = "share-memory"

    fun mb(bytes: Long): String = "%.1f".format(bytes / 1_048_576.0)

    // The summary stats are KB as strings ("12345"); absent on an odd build.
    fun statMb(info: Debug.MemoryInfo, key: String): String =
      info.getMemoryStat(key)?.toLongOrNull()?.let { mb(it * 1024L) } ?: "?"
  }
}
