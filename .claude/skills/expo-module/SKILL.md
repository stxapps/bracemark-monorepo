---
name: expo-module
description: Writing Expo native modules and views with the Expo Modules API (Swift/Kotlin/TypeScript) — the module definition DSL, native views, shared objects, config plugins, lifecycle hooks, autolinking, expo-module.config.json. Use when creating or changing native code in `apps/bracemark-expo/modules/` (e.g. bracemark-share) or a config plugin under `apps/bracemark-expo/plugins/`. Vendored from expo/skills and adapted; `docs/share-sheet.md` and `docs/expo-build.md` win on conflict.
version: 1.0.0
license: MIT
---

# Writing Expo Modules

> **Vendored from [expo/skills](https://github.com/expo/skills) (MIT, `plugins/expo/skills/expo-module`), 2026-08-23.**
> Local edits: the "In this repo" section below, the scaffolding note marked
> _(bracemark)_, and the removal of the upstream feedback command. The
> `references/` files are upstream and unedited apart from one note at the top
> of `create-expo-module.md`. Where this file and `docs/` disagree, **`docs/`
> wins** — it is the design record.

## In this repo — read before anything below

- **There is already one local module, and it is the shape to copy.**
  `apps/bracemark-expo/modules/bracemark-share` — Android only
  (`"platforms": ["android"]`), exposing `com.bracemark.share.BracemarkShareModule`
  alongside a `ShareActivity.kt`, with a hand-written `expo-module.config.json`,
  `package.json` and `android/build.gradle`. Read it before writing a second
  one; `docs/share-sheet.md` is canonical for why it exists and what it must do.
- **Qualify the word "extension", always.** Two unrelated things carry the name:
  the **browser extension** (`bracemark-extension`, a separate app) and the iOS
  **share extension** (a native target inside `bracemark-expo`, provided by
  `expo-share-extension` — not a local Expo module). Never write it bare, in
  code comments or prose. → CLAUDE.md, _Workspace_; `docs/architecture.md`.
- _(bracemark)_ **Don't point `create-expo-module` at this workspace blind.** It
  assumes a standalone package with its own tooling and example app; this is an
  npm-workspaces + Nx monorepo where packages are `@stxapps/*` raw source and a
  local module is a plain folder under `apps/bracemark-expo/modules/`, autolinked
  from there. Either hand-add a folder matching `bracemark-share`, or scaffold in
  a scratch directory and copy the parts you want in. A new standalone package
  would also need Nx tags and boundary rules — → `docs/architecture.md`.
- **`ios/` and `android/` are generated and gitignored.** A module's own
  `android/` and `ios/` folders are source and are tracked; the **app's** are not.
  Everything that touches the app's native project — permissions, Info.plist
  keys, Gradle config — belongs in `app.config.ts` or a config plugin
  (`apps/bracemark-expo/plugins/with-android-signing.js` is the existing one). An
  Xcode or Android Studio edit leaves a clean working tree and is destroyed by
  the next `expo prebuild --clean`. → `docs/expo-build.md`.
- **Native code needs a prebuild + a real build to exist.** Jest and Metro can't
  exercise any of it; the `verify` skill has the simulator/emulator recipe,
  `docs/expo-build.md` the R8/signing side.
- **New native dependencies follow the workspace version scheme**, not
  `npm install <pkg>@x`: `npx expo install` inside the app, then `*` in the app
  manifest and the real pin once in the **root** `package.json`, then
  `npm dedupe`. Never declare `expo-modules-core` anywhere — a second copy is an
  opaque native crash, not a version error. → `docs/architecture.md`
  (_dependency versions_), `docs/expo-native-deps.md`.
- **On the share path, keep the TypeScript side lazy.** `data/share-store.ts` and
  `@stxapps/expo-crypto`'s `lib/ids.ts` defer imports behind `require()` at the
  call site on purpose — everything the iOS share extension's entry imports
  statically runs on every cold share. New bindings reached from there follow the
  same rule. → `docs/share-sheet.md`, _keep `index.share.js` lean_.
- **After the change:** `npx nx lint @stxapps/bracemark-expo --fix`, then
  `npm run lint` / `npx nx typecheck @stxapps/bracemark-expo`. Read the lint
  diff — `--fix` will re-add an imported-but-undeclared dependency to a
  `package.json`, which is exactly the wrong place for a version here.
- The upstream `expo-migrate-module` skill (Modules API 2.0 macros) is **not**
  vendored — this app is on SDK 54 and the DSL form throughout.

---

Complete reference for building native modules and views using the Expo Modules API. Covers Swift (iOS), Kotlin (Android), and TypeScript.

## When to Use

- Creating a new Expo native module or native view
- Adding native functionality (camera, sensors, system APIs) to an Expo app
- Wrapping platform SDKs for React Native consumption
- Building config plugins that modify native project files
- Adding Android, Apple, or web support to an existing Expo module
- Editing `expo-module.config.json`, config plugins, or lifecycle hooks

To migrate an existing Swift module from the definition DSL to the Expo Modules API 2.0 macros (`@ExpoModule`, `@JS`, `@Event`), upstream has an `expo-migrate-module` skill — _(bracemark: not vendored, and not applicable on SDK 54; this repo writes the DSL form)_.

## References

Consult these resources as needed:

```
references/
  create-expo-module.md      Scaffolding and add-platform-support workflow, defaults, and quirks
  native-module.md           Module definition DSL: Name, Function, AsyncFunction, Property, Constant, Events, type system, shared objects
  native-view.md             Native view components: View, Prop, EventDispatcher, view lifecycle, ref-based functions
  lifecycle.md               Lifecycle hooks: module, iOS app/AppDelegate, Android activity/application listeners
  config-plugin.md           Config plugins: modifying Info.plist, AndroidManifest.xml, reading values in native code
  module-config.md           expo-module.config.json fields, file placement, and autolinking behavior
```

## Quick Start

_(bracemark: see "In this repo" — prefer copying `modules/bracemark-share`'s shape, or scaffold in a scratch directory and move the pieces in; don't run the scaffold against this workspace blind.)_

Prefer `create-expo-module` over manually creating native module files and directories. In practice, the best path is usually to create the scaffold first and then build on top of it. The scaffold sets up the expected layout, `expo-module.config.json`, podspec or Gradle files, TypeScript bindings, and the standalone example app flow.

If an existing Expo module only needs another platform, use `create-expo-module add-platform-support` instead of manually copying native directories.

See [references/create-expo-module.md](references/create-expo-module.md) before scaffolding or extending a module. It covers:

- local vs standalone modules
- `--platform`, `--features`, `--barrel`, `--package-manager`, and non-interactive mode
- `expo.autolinking.nativeModulesDir`
- `add-platform-support` behavior and quirks

## Recommended Workflow

1. Choose the scaffold type first:
   - **Local module** for one app
   - **Standalone module** for reuse, monorepos, or publishing
2. Determine native `expo-module` features that you will need.
   - Based on the user's instructions determine which feature scaffolding will be useful.
   - Available features: `Constant`, `Function`, `AsyncFunction`, `Event`, `View`, `ViewEvent`, `SharedObject`
3. Scaffold deliberately:
   - pass an explicit slug or path
   - choose `--platform` intentionally instead of relying on defaults
   - use `--features` to choose code samples which you will modify in the next step to match the real implementation.
4. Replace generated example code with the real implementation.
5. If you add a new platform later, prefer `add-platform-support` over manual file copying.

## Practical Scaffolding Rules

- Feature examples are **opt-in**. A newly scaffolded module may be minimal if no features were selected.
- `ViewEvent` implies `View`.
- Local modules do **not** generate an `index.ts` barrel by default. Use `--barrel` only if you want one.
- In non-interactive local scaffolding, pass the positional slug or path explicitly. `--name` changes the native class name, not the folder name.
- Local modules live in `expo.autolinking.nativeModulesDir` when configured, otherwise in `modules/`.
- Standalone modules have their own package metadata, scripts, and usually an example app. Local modules use the host app's tooling instead.

## Core File Shapes

The Swift and Kotlin DSL share the same structure. Swift is usually the clearest primary example; consult the references for feature-specific details.

## Module Structure Reference

The Swift and Kotlin DSL share the same structure. Both platforms are shown here for reference — in other reference files, Swift is shown as the primary language unless the Kotlin pattern meaningfully differs.

**Swift (iOS):**

```swift
import ExpoModulesCore

public class MyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MyModule")

    Function("hello") { (name: String) -> String in
      return "Hello \(name)!"
    }
  }
}
```

**Kotlin (Android):**

```kotlin
package expo.modules.mymodule

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MyModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MyModule")

    Function("hello") { name: String ->
      "Hello $name!"
    }
  }
}
```

**TypeScript:**

```typescript
import { requireNativeModule } from "expo";

const MyModule = requireNativeModule("MyModule");

export function hello(name: string): string {
  return MyModule.hello(name);
}
```

### expo-module.config.json

```json
{
  "platforms": ["android", "apple"],
  "apple": {
    "modules": ["MyModule"]
  },
  "android": {
    "modules": ["expo.modules.mymodule.MyModule"]
  }
}
```

Note: iOS uses just the class name; Android uses the fully-qualified class name (package + class). See `references/module-config.md` for all fields.

## Feedback on this file

This is a vendored copy — the upstream `submit-expo-feedback` flow is not wired
up here. If something in it is wrong for this repo, fix it in place, and when
the correction is really about the repo's design record it in `docs/`
(`share-sheet.md`, `expo-build.md`, `expo-native-deps.md`) instead.
