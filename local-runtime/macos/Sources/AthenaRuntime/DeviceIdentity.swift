import CryptoKit
import Foundation
import Security

final class DeviceIdentity {
  private let service = "online.athenallm.local-runtime"
  private let account = "device-signing-key"
  private let key: P256.Signing.PrivateKey

  init() throws {
    if let data = Self.readKeychain(service: service, account: account),
       let restored = try? P256.Signing.PrivateKey(rawRepresentation: data) {
      key = restored
    } else {
      key = P256.Signing.PrivateKey()
      try Self.storeKeychain(key.rawRepresentation, service: service, account: account)
    }
  }

  func sign(_ data: Data) throws -> String {
    try key.signature(for: data).derRepresentation.base64URLEncodedString()
  }

  var publicKeyPEM: String {
    let spkiPrefix = Data([0x30,0x59,0x30,0x13,0x06,0x07,0x2A,0x86,0x48,0xCE,0x3D,0x02,0x01,0x06,0x08,0x2A,0x86,0x48,0xCE,0x3D,0x03,0x01,0x07,0x03,0x42,0x00])
    let body = (spkiPrefix + key.publicKey.x963Representation).base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
    return "-----BEGIN PUBLIC KEY-----\n\(body)\n-----END PUBLIC KEY-----"
  }

  private static func readKeychain(service: String, account: String) -> Data? {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }

  private static func storeKeychain(_ data: Data, service: String, account: String) throws {
    let selector: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    SecItemDelete(selector as CFDictionary)
    var item = selector
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw RuntimeFailure("keychain_write_failed") }
  }
}

extension Data {
  func base64URLEncodedString() -> String {
    base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

struct RuntimeFailure: Error, LocalizedError {
  let code: String
  init(_ code: String) { self.code = code }
  var errorDescription: String? { code }
}
