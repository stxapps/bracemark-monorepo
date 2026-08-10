import ExpoModulesCore
import Security

// Keychain items under an EXPLICIT access group — the implementation behind
// src/lib/shared-keychain.ts, and the one Keychain capability expo-secure-store
// doesn't expose (it hardcodes its query and offers no access-group option).
//
// The group is an App Group id (e.g. `group.com.bracemark.app`): iOS accepts App
// Group ids as keychain access groups, so the App Group entitlement both targets
// already carry from expo-share-extension covers it — no keychain-sharing
// entitlement, no team-id prefix. This is what lets the share extension, a
// separate process that cannot read the app's own Keychain entries, see the
// session the main app mirrors there (docs/share-sheet.md).
//
// iOS-ONLY BY DESIGN: this module is registered under `apple.modules` with no
// Android counterpart, because Android's share surface runs in the app's own
// process and reads the real session store. The JS wrappers guard on
// Platform.OS before touching the native runtime, so Android never resolves it.

internal final class KeychainException: GenericException<Int32> {
  override var reason: String {
    "keychain operation failed (OSStatus \(param))"
  }
}

public class BracemarkSharedKeychainModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BracemarkSharedKeychain")

    // AFTER_FIRST_UNLOCK to match expo-secure-store's session entry (the mirror
    // must be readable wherever the original is — e.g. a share while the phone
    // hasn't been unlocked since boot fails BOTH reads consistently).
    // Set is delete-then-add: simpler than SecItemUpdate's attribute dance, and
    // the value is a few hundred bytes written once per sign-in.

    AsyncFunction("setSharedKeychainItem") { (group: String, key: String, value: String) in
      SecItemDelete(Self.keychainQuery(group, key) as CFDictionary)
      var attributes = Self.keychainQuery(group, key)
      attributes[kSecValueData as String] = Data(value.utf8)
      attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      let status = SecItemAdd(attributes as CFDictionary, nil)
      guard status == errSecSuccess else {
        throw KeychainException(status)
      }
    }

    AsyncFunction("getSharedKeychainItem") { (group: String, key: String) -> String? in
      var query = Self.keychainQuery(group, key)
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecItemNotFound {
        return nil
      }
      guard status == errSecSuccess, let data = result as? Data else {
        throw KeychainException(status)
      }
      return String(data: data, encoding: .utf8)
    }

    AsyncFunction("deleteSharedKeychainItem") { (group: String, key: String) in
      let status = SecItemDelete(Self.keychainQuery(group, key) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw KeychainException(status)
      }
    }
  }

  private static let keychainService = "com.bracemark.app.shared"

  private static func keychainQuery(_ group: String, _ key: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: key,
      kSecAttrAccessGroup as String: group,
    ]
  }
}
