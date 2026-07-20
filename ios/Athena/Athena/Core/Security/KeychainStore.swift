import Foundation
import LocalAuthentication
import Security

protocol SecureValueStore: AnyObject {
    func data(forKey key: String) throws -> Data?
    func setData(_ data: Data, forKey key: String) throws
    func protectedData(forKey key: String, prompt: String) throws -> Data?
    func setProtectedData(_ data: Data, forKey key: String) throws
    func removeData(forKey key: String) throws
}

extension SecureValueStore {
    func protectedData(forKey key: String, prompt: String) throws -> Data? {
        try data(forKey: key)
    }

    func setProtectedData(_ data: Data, forKey key: String) throws {
        try setData(data, forKey: key)
    }
}

enum KeychainStoreError: LocalizedError, Equatable {
    case unhandledStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .unhandledStatus(let status):
            "Keychain returned status \(status)"
        }
    }
}

final class KeychainStore: SecureValueStore {
    private let service: String

    init(service: String) {
        self.service = service
    }

    func data(forKey key: String) throws -> Data? {
        let query = baseQuery(forKey: key).merging([
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]) { _, new in new }

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainStoreError.unhandledStatus(status)
        }
        return item as? Data
    }

    func setData(_ data: Data, forKey key: String) throws {
        let query = baseQuery(forKey: key)
        let attributes = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as [String: Any]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus != errSecItemNotFound {
            throw KeychainStoreError.unhandledStatus(updateStatus)
        }

        var addQuery = query
        attributes.forEach { addQuery[$0.key] = $0.value }
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainStoreError.unhandledStatus(addStatus)
        }
    }

    func protectedData(forKey key: String, prompt: String) throws -> Data? {
        let context = LAContext()
        context.localizedReason = prompt
        let query = baseQuery(forKey: key).merging([
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context,
        ]) { _, new in new }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw KeychainStoreError.unhandledStatus(status)
        }
        return item as? Data
    }

    func setProtectedData(_ data: Data, forKey key: String) throws {
        _ = SecItemDelete(baseQuery(forKey: key) as CFDictionary)
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .userPresence,
            &error
        ) else {
            throw KeychainStoreError.unhandledStatus(errSecParam)
        }
        var query = baseQuery(forKey: key)
        query[kSecValueData as String] = data
        query[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainStoreError.unhandledStatus(status)
        }
    }

    func removeData(forKey key: String) throws {
        let status = SecItemDelete(baseQuery(forKey: key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            return
        }
        throw KeychainStoreError.unhandledStatus(status)
    }

    private func baseQuery(forKey key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

final class InMemorySecureValueStore: SecureValueStore {
    private var storage: [String: Data] = [:]

    func data(forKey key: String) throws -> Data? {
        storage[key]
    }

    func setData(_ data: Data, forKey key: String) throws {
        storage[key] = data
    }

    func removeData(forKey key: String) throws {
        storage.removeValue(forKey: key)
    }
}
