require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BracemarkCrypto'
  s.version        = package['version']
  s.summary        = 'Native crypto for bracemark: file-level AES-256-GCM + shared-Keychain access'
  s.description    = 'Hosts two Expo modules. BracemarkFileCrypto encrypts/decrypts whole files path-to-path in the native layer so file bytes never enter the JS heap (frozen v1 blob frame). BracemarkSharedKeychain reads/writes generic-password items under an App Group access group, which expo-secure-store cannot express.'
  s.author         = 'stxapps'
  s.homepage       = 'https://bracemark.com'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
end
