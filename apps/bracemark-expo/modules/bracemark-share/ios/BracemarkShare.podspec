require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# Local pod, path-linked from apps/bracemark-expo/modules by expo autolinking —
# into the app target AND the share-extension target, since the generated
# Podfile calls `use_expo_modules!` in both (the extension's call excludes only
# the packages named in app.config.ts). That is what puts
# BracemarkShareKeyboardModule inside the extension process, which is the only
# process that needs it.
#
# `author` is not optional even for a never-published pod: CocoaPods validates
# every spec it installs, and a missing `authors` is an ERROR (not a warning)
# that fails `pod install` outright. Worse, `expo prebuild` reports the failure
# and still exits 0, so the only symptom is a missing Podfile.lock and a build
# that cannot find the module. `license` really is warn-only, and is left off on
# purpose: the repo's licence is stated in exactly three places (root LICENSE,
# root package.json, packages/shared brand.ts) and a fourth copy here would be a
# fourth thing to keep in step — see
# docs/brand-assets.md, _the source_. (The sibling pod,
# packages/expo-crypto/ios/BracemarkCrypto.podspec, does carry an `UNLICENSED`
# type; it predates that rule and is not a precedent to copy.)
Pod::Spec.new do |s|
  s.name           = 'BracemarkShare'
  s.version        = package['version']
  # Hand-written and short rather than `package['description']`: CocoaPods warns
  # when the summary runs past 140 characters or merely repeats the description.
  s.summary        = 'Native halves of the bracemark share sheet (iOS: keyboard frames inside the share extension)'
  s.description    = package['description']
  s.author         = 'stxapps'
  s.homepage       = 'https://bracemark.com'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  s.source_files = '**/*.{h,m,swift}'
end
