require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

# No `s.license`: it is warn-only for a never-published pod, and the repo's
# licence is stated elsewhere — the sibling pod's header has the reasoning
# (apps/bracemark-expo/modules/bracemark-share/ios/BracemarkShare.podspec).
Pod::Spec.new do |s|
  s.name           = 'BracemarkCrypto'
  s.version        = package['version']
  s.summary        = 'Native crypto for bracemark: file-level AES-256-GCM + shared-Keychain access'
  s.description    = 'Hosts two Expo modules. BracemarkFileCrypto encrypts/decrypts whole files path-to-path in the native layer so file bytes never enter the JS heap (frozen v1 blob frame, bound to its sync path). BracemarkSharedKeychain reads/writes generic-password items under an App Group access group, which expo-secure-store cannot express.'
  s.author         = 'stxapps'
  s.homepage       = 'https://bracemark.com'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
