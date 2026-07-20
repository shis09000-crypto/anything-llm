import XCTest
@testable import Athena

private final class NativeContractURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: APIClientError.invalidResponse)
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class NativeAppContractTests: XCTestCase {
    override func tearDown() {
        NativeContractURLProtocol.handler = nil
        super.tearDown()
    }

    func testBootstrapDecodeKeepsIOS26NativeProtocol() throws {
        let bootstrap = try JSONDecoder().decode(NativeAppBootstrap.self, from: Self.bootstrapJSON)

        XCTAssertTrue(bootstrap.success)
        XCTAssertEqual(bootstrap.protocolVersion, "ios-native-v1")
        XCTAssertEqual(bootstrap.app.minimumOSVersion, "26.0")
        XCTAssertTrue(bootstrap.app.liquidGlass.nativeRequired)
        XCTAssertFalse(bootstrap.app.liquidGlass.fallbackPromised)
    }

    func testBootstrapDecodeKeepsV1FeatureBoundaries() throws {
        let bootstrap = try JSONDecoder().decode(NativeAppBootstrap.self, from: Self.bootstrapJSON)

        XCTAssertFalse(bootstrap.features.nativePush)
        XCTAssertFalse(bootstrap.auth.appleSignInAvailable)
        XCTAssertFalse(bootstrap.features.admin)
        XCTAssertFalse(bootstrap.features.crypto)
        XCTAssertFalse(bootstrap.features.localModel)
    }

    func testBootstrapDecodesNativeOpaqueCompatibilityMetadata() throws {
        let enriched = String(data: Self.bootstrapJSON, encoding: .utf8)!
            .replacingOccurrences(
                of: #""sensitiveSessionHeader": "X-Athena-Sensitive-Session""#,
                with: """
                "sensitiveSessionHeader": "X-Athena-Sensitive-Session",
                "opaque": {
                  "available": true,
                  "protocolVersion": "opaque-ke-4.0.0",
                  "keyStretching": "memory-constrained",
                  "serverStaticPublicKey": "server-public-key",
                  "serverStaticPublicKeyFingerprint": "sha256:fingerprint",
                  "status": "ready"
                }
                """
            )
        let bootstrap = try JSONDecoder().decode(
            NativeAppBootstrap.self,
            from: Data(enriched.utf8)
        )

        XCTAssertEqual(bootstrap.security.opaque?.protocolVersion, "opaque-ke-4.0.0")
        XCTAssertEqual(
            bootstrap.security.opaque?.serverStaticPublicKeyFingerprint,
            "sha256:fingerprint"
        )
    }

    func testPreflightDecodeAcceptsIOS26() throws {
        let preflight = try JSONDecoder().decode(NativeAppPreflight.self, from: Self.preflightJSON)

        XCTAssertTrue(preflight.compatible)
        XCTAssertFalse(preflight.blocked)
        XCTAssertEqual(preflight.policy.minimumOSVersion, "26.0")
        XCTAssertEqual(preflight.protocolVersion, "ios-native-v1")
    }

    func testMarkdownParserRemovesModelFormattingSyntax() throws {
        let blocks = AthenaMarkdownDocumentParser.parse(
            """
            ## 结论

            这是 **重要内容**。

            - 第一项
            - 第二项

            ```swift
            let ready = true
            ```

            | 项目 | 状态 |
            | --- | --- |
            | 登录 | 完成 |
            """
        )

        guard case .heading(_, let heading) = blocks[0].kind else {
            return XCTFail("Expected heading block")
        }
        XCTAssertEqual(String(heading.characters), "结论")

        guard case .paragraph(let paragraph) = blocks[1].kind else {
            return XCTFail("Expected paragraph block")
        }
        XCTAssertEqual(String(paragraph.characters), "这是 重要内容。")

        guard case .unorderedList(let items) = blocks[2].kind else {
            return XCTFail("Expected unordered list block")
        }
        XCTAssertEqual(items.count, 2)

        guard case .code(_, let code) = blocks[3].kind else {
            return XCTFail("Expected code block")
        }
        XCTAssertEqual(code.trimmingCharacters(in: .whitespacesAndNewlines), "let ready = true")

        guard case .table(let header, let rows) = blocks[4].kind else {
            return XCTFail("Expected table block")
        }
        XCTAssertEqual(header.map { String($0.characters) }, ["项目", "状态"])
        XCTAssertEqual(rows.first?.map { String($0.characters) }, ["登录", "完成"])
    }

    func testMarkdownParserPreservesLongTableCellContent() throws {
        let longText = "这是一段需要在表格单元格内完整换行显示，而不能被省略号截断的长文本内容。"
        let blocks = AthenaMarkdownDocumentParser.parse(
            """
            | 项目 | 说明 |
            | --- | --- |
            | 表格 | \(longText) |
            """
        )

        guard case .table(_, let rows) = blocks.first?.kind else {
            return XCTFail("Expected table block")
        }
        XCTAssertEqual(String(rows[0][1].characters), longText)
    }

    func testDrawerGestureClassifierRejectsVerticalConversationScrolling() {
        XCTAssertFalse(
            DrawerGestureClassifier.hasHorizontalIntent(
                translation: CGSize(width: 24, height: 120),
                drawerOpen: false
            )
        )
        XCTAssertFalse(
            DrawerGestureClassifier.hasHorizontalIntent(
                translation: CGSize(width: 24, height: 20),
                drawerOpen: false
            )
        )
        XCTAssertFalse(
            DrawerGestureClassifier.hasHorizontalIntent(
                translation: CGSize(width: -80, height: 8),
                drawerOpen: false
            )
        )
        XCTAssertTrue(
            DrawerGestureClassifier.hasHorizontalIntent(
                translation: CGSize(width: 80, height: 12),
                drawerOpen: false
            )
        )
        XCTAssertTrue(
            DrawerGestureClassifier.hasHorizontalIntent(
                translation: CGSize(width: -80, height: 12),
                drawerOpen: true
            )
        )
    }

    func testMessageActionCapabilitiesKeepUserActionSlotsStable() {
        let pending = MessageActionCapabilities.user(
            isConfirmed: false,
            canEdit: true
        )
        XCTAssertEqual(pending.visibleActions, [.copy, .edit])
        XCTAssertEqual(pending.enabledActions, [.copy])

        let confirmed = MessageActionCapabilities.user(
            isConfirmed: true,
            canEdit: true
        )
        XCTAssertEqual(confirmed.visibleActions, [.copy, .edit])
        XCTAssertEqual(confirmed.enabledActions, [.copy, .edit])
    }

    func testMessageActionCapabilitiesKeepAssistantActionSlotsStable() {
        let streaming = MessageActionCapabilities.assistant(
            isConfirmed: false,
            isLastConfirmedAssistant: true,
            hasStableServerIdentity: true,
            canRegenerate: true,
            canFork: true,
            canDelete: true
        )
        XCTAssertTrue(streaming.visibleActions.isEmpty)

        let preview = MessageActionCapabilities.assistant(
            isConfirmed: true,
            isLastConfirmedAssistant: true,
            hasStableServerIdentity: false,
            canRegenerate: false,
            canFork: false,
            canDelete: false
        )
        XCTAssertEqual(
            preview.visibleActions,
            [.copy, .speech, .regenerate, .fork, .delete]
        )
        XCTAssertEqual(preview.enabledActions, [.copy, .speech])

        let historical = MessageActionCapabilities.assistant(
            isConfirmed: true,
            isLastConfirmedAssistant: false,
            hasStableServerIdentity: true,
            canRegenerate: true,
            canFork: true,
            canDelete: true
        )
        XCTAssertEqual(
            historical.visibleActions,
            [.copy, .speech, .regenerate, .fork, .delete]
        )
        XCTAssertFalse(historical.isEnabled(.regenerate))
        XCTAssertTrue(historical.isEnabled(.fork))
        XCTAssertTrue(historical.isEnabled(.delete))

        let latest = MessageActionCapabilities.assistant(
            isConfirmed: true,
            isLastConfirmedAssistant: true,
            hasStableServerIdentity: true,
            canRegenerate: true,
            canFork: true,
            canDelete: true
        )
        XCTAssertEqual(
            latest.enabledActions,
            [.copy, .speech, .regenerate, .fork, .delete]
        )
    }

    @MainActor
    func testCompatibilityContractHandlesLegacyHTMLPublicRoutes() async throws {
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [NativeContractURLProtocol.self]
        let apiClient = APIClient(
            configuration: APIClientConfiguration(
                baseURL: URL(string: "https://athenallm.online")!,
                appVersion: "0.1.0",
                osVersion: "26.5",
                platform: "ios"
            ),
            session: URLSession(configuration: sessionConfiguration)
        )
        NativeContractURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/html"]
            )!
            return (response, Data("<html>Athena</html>".utf8))
        }

        let profile = NativeClientProfile(
            appVersion: "0.1.0",
            osVersion: "26.5",
            platform: "ios"
        )
        let client = NativeBootstrapClient(
            apiClient: apiClient,
            compatibilityBootstrap: NativeCompatibilityContract.bootstrap(
                baseURL: apiClient.configuration.baseURL
            ),
            compatibilityPreflight: NativeCompatibilityContract.preflight(profile: profile)
        )

        let bootstrap = try await client.fetchBootstrap()
        let preflight = try await client.fetchPreflight()

        XCTAssertEqual(bootstrap.protocolVersion, "ios-native-v1")
        XCTAssertEqual(bootstrap.security.signingSecretPath, "/api/client-identity/signing-secret")
        XCTAssertFalse(preflight.blocked)
        XCTAssertEqual(preflight.warnings, ["native_contract_route_unavailable"])
    }

    @MainActor
    func testAPIClientBuildsAbsoluteAPIURL() throws {
        let client = APIClient(
            configuration: APIClientConfiguration(
                baseURL: URL(string: "https://athenallm.online")!,
                appVersion: "0.1.0",
                osVersion: "26.0",
                platform: "ios"
            )
        )

        let url = try client.url(
            for: "/api/native-app/preflight",
            queryItems: [URLQueryItem(name: "platform", value: "ios")]
        )

        XCTAssertEqual(url.absoluteString, "https://athenallm.online/api/native-app/preflight?platform=ios")
    }

    @MainActor
    func testAPIClientDoesNotDoubleAPIPathWhenBaseEndsInAPI() throws {
        let client = APIClient(
            configuration: APIClientConfiguration(
                baseURL: URL(string: "https://athenallm.online/api")!,
                appVersion: "0.1.0",
                osVersion: "26.0",
                platform: "ios"
            )
        )

        let url = try client.url(for: "/api/native-app/bootstrap")

        XCTAssertEqual(url.absoluteString, "https://athenallm.online/api/native-app/bootstrap")
    }

    private static let bootstrapJSON = Data(
        """
        {
          "success": true,
          "protocolVersion": "ios-native-v1",
          "generatedAt": "2026-07-08T00:00:00.000Z",
          "app": {
            "name": "Athena",
            "platform": "ios",
            "platforms": ["ios", "ipad"],
            "minimumOSVersion": "26.0",
            "deploymentVersion": "local",
            "versionPolicy": {
              "minSupportedAppVersion": null,
              "recommendedAppVersion": null
            },
            "liquidGlass": {
              "nativeRequired": true,
              "swiftUIAvailability": "iOS 26+",
              "fallbackPromised": false
            }
          },
          "transport": {
            "apiBasePath": "/api",
            "httpsRequired": true,
            "webSocketSecureRequired": true,
            "publicAppUrl": "https://athenallm.online",
            "sseSupported": true,
            "webSocketSupported": true,
            "runtime": {
              "mode": "production",
              "production": true,
              "httpsRequired": true,
              "trustProxyEnabled": true,
              "forceHttps": true,
              "publicAppUrlHttps": true,
              "hstsConfigured": true,
              "tlsMinVersion": "TLSv1.2",
              "tls13Recommended": true,
              "webSocketSecureRequired": true
            }
          },
          "auth": {
            "passwordLoginPath": "/api/request-token",
            "checkTokenPath": "/api/system/check-token",
            "userActionPath": "/api/system/user-action",
            "passkeyAvailable": true,
            "appleSignInAvailable": false
          },
          "security": {
            "clientIdentityRequired": true,
            "clientIdentityHeaders": { "clientId": "X-Athena-Client-Id" },
            "clientIdentityQuery": { "clientId": "athenaClientId" },
            "nativeAppHeaders": { "osVersion": "X-Athena-OS-Version" },
            "preferredSignatureVersion": "v2-device-p256",
            "requestSigningHeaders": { "signature": "X-Athena-Signature" },
            "signingSecretPath": "/api/client-identity/signing-secret",
            "sensitiveSessionHeader": "X-Athena-Sensitive-Session"
          },
          "features": {
            "workspaceThreads": true,
            "chatSSE": true,
            "reader": true,
            "readerMaxUploadBytes": 524288000,
            "agentWebSocket": true,
            "broadcastWebSocket": true,
            "broadcastDurableTransport": false,
            "userStateSync": true,
            "nativePush": false,
            "webPushOnly": true,
            "universalLinks": false,
            "fullOffline": false,
            "admin": false,
            "crypto": false,
            "localModel": false
          },
          "endpoints": {
            "bootstrapPath": "/api/native-app/bootstrap",
            "preflightPath": "/api/native-app/preflight",
            "broadcastWebSocketPath": "/api/realtime/broadcast",
            "syncEventsPath": "/api/sync/events",
            "userStatePath": "/api/system/user/state",
            "readerStandaloneBasePath": "/api/reader-documents",
            "readerWorkspaceBasePathTemplate": "/api/workspace/:slug/reader-documents",
            "agentWebSocketPathTemplate": "/api/agent-invocation/:uuid",
            "agentStatePathTemplate": "/api/agent-invocation/:uuid/state",
            "appleAppSiteAssociationPath": "/.well-known/apple-app-site-association"
          },
          "readiness": {
            "p0": [],
            "p1": [],
            "summary": {
              "serverP0Ready": true,
              "serverP1Ready": false,
              "nativeClientRequired": [],
              "externalConfigurationRequired": []
            }
          }
        }
        """.utf8
    )

    private static let preflightJSON = Data(
        """
        {
          "success": true,
          "protocolVersion": "ios-native-v1",
          "generatedAt": "2026-07-08T00:00:00.000Z",
          "platform": "ios",
          "compatible": true,
          "blocked": false,
          "updateRecommended": false,
          "reasons": [],
          "warnings": [],
          "policy": {
            "minimumOSVersion": "26.0",
            "minSupportedAppVersion": null,
            "recommendedAppVersion": null
          },
          "appVersion": {
            "appVersion": "0.1.0",
            "minSupportedAppVersion": null,
            "recommendedAppVersion": null,
            "compatible": true,
            "blocked": false,
            "updateRecommended": false
          },
          "osVersion": {
            "osVersion": "26.0",
            "minimumOSVersion": "26.0",
            "compatible": true,
            "blocked": false
          }
        }
        """.utf8
    )
}
