import Foundation
import XCTest
@testable import Athena

final class KeychainStoreTests: XCTestCase {
    func testInMemorySecureStoreDoesNotWriteUserDefaults() throws {
        let defaultsKey = "athena.test.secret"
        UserDefaults.standard.removeObject(forKey: defaultsKey)

        let store = InMemorySecureValueStore()
        try store.setData(Data("secret".utf8), forKey: defaultsKey)

        XCTAssertEqual(try store.data(forKey: defaultsKey), Data("secret".utf8))
        XCTAssertNil(UserDefaults.standard.object(forKey: defaultsKey))
    }

    func testProtectedValuesRemainInsideSecureStoreAbstraction() throws {
        let key = "athena.test.protected-secret"
        let store = InMemorySecureValueStore()
        let secret = Data("device-only-secret".utf8)

        try store.setProtectedData(secret, forKey: key)

        XCTAssertEqual(
            try store.protectedData(forKey: key, prompt: "Authenticate"),
            secret
        )
        XCTAssertNil(UserDefaults.standard.object(forKey: key))
    }

    @MainActor
    func testAuthCenterStoresTokenThroughSecureStore() throws {
        let store = InMemorySecureValueStore()
        let authCenter = AuthCenter(secureStore: store)

        try authCenter.storeToken("token-value")

        try authCenter.restore()
        XCTAssertEqual(authCenter.state, .tokenStored)
        XCTAssertNil(UserDefaults.standard.object(forKey: "auth.accessToken"))
    }
}
