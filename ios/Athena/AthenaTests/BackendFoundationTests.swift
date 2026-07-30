import Foundation
import XCTest
@testable import Athena

private final class AthenaTestURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

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

private actor InvocationCounter {
    private(set) var value = 0

    func increment() {
        value += 1
    }
}

final class BackendFoundationTests: XCTestCase {
    override func tearDown() {
        AthenaTestURLProtocol.handler = nil
        super.tearDown()
    }

    @MainActor
    func testProtectedRequestCannotRunWithoutLoginToken() async throws {
        let client = makeClient().client
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            return Self.response(for: request, json: "{}")
        }

        do {
            _ = try await client.getJSON(
                APIEmptyResponse.self,
                path: "/api/workspaces",
                authorization: .required
            )
            XCTFail("Expected authenticationRequired")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .authenticationRequired)
        }
        XCTAssertEqual(requestCount, 0)
    }

    @MainActor
    func testDeviceIdentityRecoveryHintIsSeparatedAndRecoveryIsCoalesced() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.signing.prepareDeviceKey()
        try secured.auth.storeToken("session-token")
        var incidents: [APISecurityIncident] = []
        secured.client.securityRecoveryHandler = { incident in
            incidents.append(incident)
            return false
        }
        AthenaTestURLProtocol.handler = { request in
            Self.response(
                for: request,
                status: 401,
                json: """
                {"success":false,"error":"INVALID_SIGNATURE","recovery":"CLIENT_IDENTITY_REAUTH_REQUIRED"}
                """
            )
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/system/user/state",
                authorization: .required
            )
            XCTFail("Expected device identity recovery")
        } catch let error as APIClientError {
            XCTAssertEqual(
                error,
                .clientIdentityReauthenticationRequired("INVALID_SIGNATURE")
            )
        }
        XCTAssertEqual(incidents, [.clientIdentityReauthRequired])

        let gate = APISecurityRecoveryGate()
        var recoveryCount = 0
        let tasks = (0..<10).map { _ in
            Task { @MainActor in
                await gate.run {
                    recoveryCount += 1
                    try? await Task.sleep(for: .milliseconds(25))
                    return true
                }
            }
        }
        for task in tasks {
            let recovered = await task.value
            XCTAssertTrue(recovered)
        }
        XCTAssertEqual(recoveryCount, 1)
    }

    @MainActor
    func testProtectedRequestCannotRunWithoutClientIdentity() async throws {
        let secured = makeClient()
        try secured.auth.storeToken("session-token")
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            return Self.response(for: request, json: "{}")
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/workspaces",
                authorization: .required
            )
            XCTFail("Expected clientIdentityRequired")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .clientIdentityRequired)
        }
        XCTAssertEqual(requestCount, 0)
    }

    @MainActor
    func testAuthenticatedRequestCarriesSessionAndClientIdentity() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")

        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Athena-Client-Id"), secured.identity.clientID)
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Athena-Platform"), "ios")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Request-Id"))
            return Self.response(for: request, json: "{}")
        }

        _ = try await secured.client.getJSON(
            APIEmptyResponse.self,
            path: "/api/workspaces",
            authorization: .required
        )
    }

    @MainActor
    func testIdempotentGetRetriesGatewayFailureAndRecovers() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            if requestCount == 1 {
                return Self.response(
                    for: request,
                    status: 502,
                    json: #"{"error":"temporary gateway failure"}"#
                )
            }
            return Self.response(for: request, json: "{}")
        }

        _ = try await secured.client.getJSON(
            APIEmptyResponse.self,
            path: "/api/workspaces",
            authorization: .required
        )

        XCTAssertEqual(requestCount, 2)
    }

    @MainActor
    func testMutationDoesNotRetryGatewayFailure() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            return Self.response(
                for: request,
                status: 502,
                json: #"{"error":"temporary gateway failure"}"#
            )
        }

        do {
            _ = try await secured.client.requestJSON(
                APIEmptyResponse.self,
                method: .post,
                path: "/api/workspace/new",
                body: ["name": "Workspace"],
                authorization: .required
            )
            XCTFail("Expected HTTP 502")
        } catch let error as APIClientError {
            XCTAssertEqual(
                error,
                .httpStatus(
                    status: 502,
                    code: "temporary gateway failure",
                    message: "temporary gateway failure"
                )
            )
        }
        XCTAssertEqual(requestCount, 1)
    }

    @MainActor
    func testAuthenticationFailureIsNeverRetriedAsTransient() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            return Self.response(
                for: request,
                status: 401,
                json: #"{"error":"session_revoked"}"#
            )
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/workspaces",
                authorization: .required
            )
            XCTFail("Expected HTTP 401")
        } catch let error as APIClientError {
            XCTAssertEqual(
                error,
                .httpStatus(
                    status: 401,
                    code: "session_revoked",
                    message: "session_revoked"
                )
            )
        }
        XCTAssertEqual(requestCount, 1)
    }

    @MainActor
    func testStandardSessionReasonCodeTriggersSilentRecovery() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.signing.prepareDeviceKey()
        try secured.auth.storeToken("expired-session-token")
        var incidents: [APISecurityIncident] = []
        secured.client.securityRecoveryHandler = { incident in
            incidents.append(incident)
            return false
        }
        AthenaTestURLProtocol.handler = { request in
            Self.response(
                for: request,
                status: 401,
                json: """
                {
                  "error":"Session expired due to inactivity.",
                  "reasonCode":"session_idle_expired"
                }
                """
            )
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/workspaces",
                authorization: .required
            )
            XCTFail("Expected HTTP 401")
        } catch let error as APIClientError {
            XCTAssertEqual(
                error,
                .httpStatus(
                    status: 401,
                    code: "session_idle_expired",
                    message: "Session expired due to inactivity."
                )
            )
        }
        XCTAssertEqual(incidents, [.sessionExpired])
    }

    @MainActor
    func testDeviceBoundSessionRecoveryReissuesTokenWithoutNewLogin() async throws {
        let secured = makeClient()
        let clientID = try secured.identity.prepare()
        try secured.signing.prepareDeviceKey()
        try secured.auth.storeToken("original-session-token")

        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/auth/session/recovery/enroll":
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "Authorization"),
                    "Bearer original-session-token"
                )
                XCTAssertNotNil(
                    request.value(forHTTPHeaderField: "X-Athena-PQ-Signature")
                )
                return Self.response(
                    for: request,
                    json: """
                    {
                      "success":true,
                      "recoveryHandle":"device-bound-handle",
                      "expiresAt":"2026-08-30T00:00:00.000Z"
                    }
                    """
                )
            case "/api/auth/session/recovery/start":
                XCTAssertNil(
                    request.value(forHTTPHeaderField: "Authorization")
                )
                return Self.response(
                    for: request,
                    json: """
                    {
                      "success":true,
                      "recoveryTicket":"one-time-ticket"
                    }
                    """
                )
            case "/api/auth/session/recovery/finish":
                XCTAssertNil(
                    request.value(forHTTPHeaderField: "Authorization")
                )
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "X-Athena-Client-Id"),
                    clientID
                )
                XCTAssertNotNil(
                    request.value(forHTTPHeaderField: "X-Athena-PQ-Signature")
                )
                return Self.response(
                    for: request,
                    json: """
                    {
                      "success":true,
                      "valid":true,
                      "user":{
                        "id":10,
                        "authUserId":100,
                        "username":"owner",
                        "role":"owner",
                        "email":"owner@example.com",
                        "phone":null,
                        "displayName":"Owner",
                        "pfpFilename":null,
                        "bio":null
                      },
                      "token":"reissued-session-token"
                    }
                    """
                )
            default:
                XCTFail("Unexpected recovery path \(request.url?.path ?? "nil")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }

        try await secured.auth.enrollSessionRecovery(
            clientID: clientID,
            using: secured.client
        )
        try secured.auth.clearToken()
        let result = await secured.auth.recoverStoredSession(
            clientID: clientID,
            source: "bootstrap",
            using: secured.client
        )

        XCTAssertEqual(result, .recovered)
        XCTAssertEqual(secured.auth.accessToken, "reissued-session-token")
        XCTAssertEqual(secured.auth.user?.authenticationID, 100)
        XCTAssertTrue(
            secured.auth.hasSessionRecoveryBinding(for: clientID)
        )
    }

    @MainActor
    func testPostQuantumRequirementIsNotMisclassifiedAsSessionExpiry() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            return Self.response(
                for: request,
                status: 401,
                json: #"{"success":false,"error":"INVALID_SIGNATURE","reason":"post_quantum_signature_required"}"#
            )
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/sync/events/replay",
                authorization: .required
            )
            XCTFail("Expected postQuantumSigningUnavailable")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .postQuantumSigningUnavailable)
        }
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(secured.auth.accessToken, "session-token")
    }

    @MainActor
    func testRootAuthorizationRequirementDoesNotClearValidSession() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        var incidents: [APISecurityIncident] = []
        secured.client.securityRecoveryHandler = { incident in
            incidents.append(incident)
            return false
        }
        AthenaTestURLProtocol.handler = { request in
            Self.response(
                for: request,
                status: 401,
                json: #"{"success":false,"error":"hybrid_signed_shared_identity_required"}"#
            )
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/vault/user-root-key/authorization-targets",
                authorization: .required
            )
            XCTFail("Expected Root authorization requirement")
        } catch let error as APIClientError {
            XCTAssertEqual(
                error,
                .httpStatus(
                    status: 401,
                    code: "hybrid_signed_shared_identity_required",
                    message: "hybrid_signed_shared_identity_required"
                )
            )
        }
        XCTAssertTrue(incidents.isEmpty)
        XCTAssertEqual(secured.auth.accessToken, "session-token")
    }

    @MainActor
    func testRevokedSessionStillTriggersSessionRecovery() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        var incidents: [APISecurityIncident] = []
        secured.client.securityRecoveryHandler = { incident in
            incidents.append(incident)
            return false
        }
        AthenaTestURLProtocol.handler = { request in
            Self.response(
                for: request,
                status: 401,
                json: #"{"success":false,"error":"session_revoked"}"#
            )
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/workspaces",
                authorization: .required
            )
            XCTFail("Expected revoked session")
        } catch let error as APIClientError {
            XCTAssertEqual(
                error,
                .httpStatus(
                    status: 401,
                    code: "session_revoked",
                    message: "session_revoked"
                )
            )
        }
        XCTAssertEqual(incidents, [.sessionExpired])
    }

    @MainActor
    func testSignedRequestFailsClosedWithoutStrictPostQuantumContract() async throws {
        let secured = makeClient(strictPostQuantum: false)
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            return Self.response(for: request, json: "{}")
        }

        do {
            _ = try await secured.client.getJSON(
                APIEmptyResponse.self,
                path: "/api/sync/events/replay",
                authorization: .required,
                signing: .required
            )
            XCTFail("Expected postQuantumSigningUnavailable")
        } catch let error as APIClientError {
            XCTAssertEqual(error, .postQuantumSigningUnavailable)
        }
        XCTAssertEqual(requestCount, 0)
        XCTAssertFalse(secured.signing.postQuantumContractReady)
    }

    @MainActor
    func testSignedRequestUsesDeviceP256Headers() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()

        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "X-Athena-Signature-Version"),
                "v2-device-p256"
            )
            XCTAssertTrue(
                ["p256-software-v1", "p256-secure-enclave-v1"].contains(
                    request.value(forHTTPHeaderField: "X-Athena-Device-Key-Algorithm") ?? ""
                )
            )
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Device-Public-Key"))
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Body-SHA256"))
            return Self.response(for: request, json: "{}")
        }

        _ = try await secured.client.requestJSON(
            APIEmptyResponse.self,
            method: .patch,
            path: "/api/system/user/state",
            body: ["value": "test"],
            authorization: .required,
            signing: .required
        )
    }

    @MainActor
    func testSignedWebSocketMessageUsesStrictHybridPostQuantumEnvelope() throws {
        let secured = makeClient()
        let clientID = try secured.identity.prepare()
        try secured.signing.prepareDeviceKey()

        let data = try secured.signing.signedWebSocketMessage(
            payload: ["type": "hello"],
            url: URL(string: "wss://athena.test/api/realtime/broadcast")!,
            clientID: clientID
        )
        let envelope = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        let signed = try XCTUnwrap(envelope["signed"] as? [String: Any])

        XCTAssertEqual(envelope["signatureVersion"] as? String, "v2-device-p256")
        XCTAssertEqual(
            signed["hybridSignatureVersion"] as? String,
            "device-hybrid-p256-mldsa65-v1"
        )
        XCTAssertEqual(
            signed["pqKeyAlgorithm"] as? String,
            "request-device-mldsa65-v1"
        )
        XCTAssertEqual(
            Self.base64URLData(
                try XCTUnwrap(signed["pqSignature"] as? String)
            )?.count,
            3_309
        )
        XCTAssertEqual(
            Self.base64URLData(
                try XCTUnwrap(signed["pqPublicKey"] as? String)
            )?.count,
            1_952
        )
    }

    @MainActor
    func testThreadChatModelMappingAndSignedUpdateContract() async throws {
        XCTAssertEqual(ThreadChatModel.flash.displayName, "快速")
        XCTAssertEqual(ThreadChatModel.pro.displayName, "深度思考")

        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()

        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(
                request.url?.path,
                "/api/workspace/alpha/thread/thread-a/update"
            )
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer session-token"
            )
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            let body = try XCTUnwrap(Self.bodyData(for: request))
            let payload = try XCTUnwrap(
                JSONSerialization.jsonObject(with: body) as? [String: String]
            )
            XCTAssertEqual(payload["chatModel"], "deepseek-v4-flash")
            XCTAssertEqual(payload["sourceActionId"], "model-action")
            return Self.response(
                for: request,
                json: """
                {"thread":{"id":11,"name":"Thread A","title":"Thread A","slug":"thread-a","thread_type":"chat","chatModel":"deepseek-v4-flash"},"message":null}
                """
            )
        }

        let thread = try await WorkspaceAPI(apiClient: secured.client).updateThreadModel(
            workspaceID: "alpha",
            threadID: "thread-a",
            model: .flash,
            sourceActionID: "model-action"
        )
        XCTAssertEqual(thread.chatModel, .flash)
    }

    @MainActor
    func testOverviewModelUsesSignedWorkspaceUpdateContract() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()

        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/workspace/alpha/update")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            let payload = try XCTUnwrap(
                JSONSerialization.jsonObject(
                    with: try XCTUnwrap(Self.bodyData(for: request))
                )
                    as? [String: String]
            )
            XCTAssertEqual(payload["chatModel"], "deepseek-v4-flash")
            XCTAssertEqual(payload["sourceActionId"], "overview-model-action")
            return Self.response(
                for: request,
                json: #"{"workspace":{"id":1,"name":"Alpha","slug":"alpha","chatModel":"deepseek-v4-flash"},"message":null}"#
            )
        }

        let workspace = try await WorkspaceAPI(apiClient: secured.client).updateWorkspaceModel(
            workspaceID: "alpha",
            model: .flash,
            sourceActionID: "overview-model-action"
        )
        XCTAssertEqual(workspace.chatModel, .flash)
    }

    @MainActor
    func testThreadDeleteAcceptsJSONLegacyOKAndEmptySuccessBodies() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()
        let responseBodies = [#"{"success":true}"#, "OK", ""]
        var responseIndex = 0

        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "DELETE")
            XCTAssertEqual(request.url?.path, "/api/workspace/alpha/thread/thread-a")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            defer { responseIndex += 1 }
            return Self.response(for: request, json: responseBodies[responseIndex])
        }

        let api = WorkspaceAPI(apiClient: secured.client)
        for index in responseBodies.indices {
            try await api.deleteThread(
                workspaceID: "alpha",
                threadID: "thread-a",
                sourceActionID: "delete-action-\(index)"
            )
        }
        XCTAssertEqual(responseIndex, responseBodies.count)
    }

    @MainActor
    func testChatStreamParsesCompleteTextAndFinalIdentifiers() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let stream = """
        data: {"uuid":"reply-1","type":"textResponse","textResponse":"完整回复","close":true}

        data: {"uuid":"reply-1","type":"finalizeResponseStream","chatId":42,"publicChatId":"public-42","clientTurnId":"turn-42","close":true}

        """
        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/workspace/alpha/thread/thread-a/stream-chat")
            return Self.response(
                for: request,
                contentType: "text/event-stream",
                data: Data(stream.utf8)
            )
        }

        var events: [ChatStreamEvent] = []
        try await ChatStreamClient(apiClient: secured.client).consumeThreadStream(
            workspaceID: "alpha",
            threadID: "thread-a",
            request: ChatStreamRequest(message: "hello", clientTurnID: "turn-42")
        ) { event in
            events.append(event)
        }

        XCTAssertEqual(
            events,
            [
                .assistantText(
                    id: "reply-1",
                    text: "完整回复",
                    replaces: true,
                    closes: true
                ),
                .finalized(
                    chatID: 42,
                    publicChatID: "public-42",
                    clientTurnID: "turn-42"
                ),
            ]
        )
    }

    @MainActor
    func testChatStreamEmitsIncrementalChunksBeforeFinalization() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let stream = """
        data: {"uuid":"reply-2","type":"textResponseChunk","textResponse":"第一段","close":false}

        data: {"uuid":"reply-2","type":"textResponseChunk","textResponse":"第二段","close":false}

        data: {"uuid":"reply-2","type":"finalizeResponseStream","chatId":43,"clientTurnId":"turn-43","close":true}

        """
        AthenaTestURLProtocol.handler = { request in
            Self.response(
                for: request,
                contentType: "text/event-stream",
                data: Data(stream.utf8)
            )
        }

        var events: [ChatStreamEvent] = []
        try await ChatStreamClient(apiClient: secured.client).consumeThreadStream(
            workspaceID: "alpha",
            threadID: "thread-a",
            request: ChatStreamRequest(message: "hello", clientTurnID: "turn-43")
        ) { event in
            events.append(event)
        }

        XCTAssertEqual(
            events,
            [
                .assistantText(
                    id: "reply-2",
                    text: "第一段",
                    replaces: false,
                    closes: false
                ),
                .assistantText(
                    id: "reply-2",
                    text: "第二段",
                    replaces: false,
                    closes: false
                ),
                .finalized(chatID: 43, publicChatID: nil, clientTurnID: "turn-43"),
            ]
        )
    }

    @MainActor
    func testChatStreamResumeUsesPersistedRevisionAndEmitsCheckpoints() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let stream = """
        data: {"runRevision":8,"uuid":"reply-resume","type":"fullTextResponse","textResponse":"后台完成的回复","close":true}

        data: {"runRevision":9,"uuid":"reply-resume","type":"finalizeResponseStream","chatId":51,"publicChatId":"public-51","clientTurnId":"turn-resume","close":true}

        """
        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(
                request.url?.path,
                "/api/workspace/alpha/thread/thread-a/chat-runs/turn-resume/stream"
            )
            XCTAssertEqual(request.url?.query, "afterRevision=4")
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer session-token"
            )
            return Self.response(
                for: request,
                contentType: "text/event-stream",
                data: Data(stream.utf8)
            )
        }

        var events: [ChatStreamEvent] = []
        try await ChatStreamClient(apiClient: secured.client).resumeThreadStream(
            workspaceID: "alpha",
            threadID: "thread-a",
            clientTurnID: "turn-resume",
            afterRevision: 4
        ) { event in
            events.append(event)
        }

        XCTAssertEqual(
            events,
            [
                .checkpoint(revision: 8),
                .assistantText(
                    id: "reply-resume",
                    text: "后台完成的回复",
                    replaces: true,
                    closes: true
                ),
                .checkpoint(revision: 9),
                .finalized(
                    chatID: 51,
                    publicChatID: "public-51",
                    clientTurnID: "turn-resume"
                ),
            ]
        )
    }

    @MainActor
    func testChatStreamStateUsesAuthenticatedOwnerScopedEndpoint() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(
                request.url?.path,
                "/api/workspace/alpha/thread/thread-a/chat-runs/turn-state/state"
            )
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer session-token"
            )
            return Self.response(
                for: request,
                json: """
                {
                  "success": true,
                  "run": {
                    "kind": "thread",
                    "clientTurnId": "turn-state",
                    "status": "running",
                    "revision": 17,
                    "terminal": false,
                    "retryable": true,
                    "finalChatId": null,
                    "finalPublicChatId": null,
                    "errorCode": null
                  }
                }
                """
            )
        }

        let state = try await ChatStreamClient(apiClient: secured.client).threadRunState(
            workspaceID: "alpha",
            threadID: "thread-a",
            clientTurnID: "turn-state"
        )

        XCTAssertEqual(state.status, "running")
        XCTAssertEqual(state.revision, 17)
        XCTAssertTrue(state.retryable)
        XCTAssertFalse(state.terminal)
    }

    @MainActor
    func testChatStreamExplicitStopUsesSignedServerCancellation() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()
        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(
                request.url?.path,
                "/api/workspace/alpha/thread/thread-a/chat-runs/turn-stop/cancel"
            )
            XCTAssertEqual(
                request.value(forHTTPHeaderField: "Authorization"),
                "Bearer session-token"
            )
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            return Self.response(
                for: request,
                json: #"{"success":true,"status":"cancelling"}"#
            )
        }

        try await ChatStreamClient(apiClient: secured.client).cancelThreadRun(
            workspaceID: "alpha",
            threadID: "thread-a",
            clientTurnID: "turn-stop"
        )
    }

    @MainActor
    func testChatStreamAppliesAutomaticThreadRenameBeforeFinalization() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let stream = """
        data: {"action":"rename_thread","thread":{"slug":"thread-a","name":"宏观政策更新","title":"宏观政策更新","titleVersion":2,"animate":true}}

        data: {"uuid":"reply-title","type":"textResponseChunk","textResponse":"流式回答","close":false}

        data: {"uuid":"reply-title","type":"finalizeResponseStream","chatId":44,"publicChatId":"public-44","clientTurnId":"turn-44","close":true}

        """
        AthenaTestURLProtocol.handler = { request in
            Self.response(
                for: request,
                contentType: "text/event-stream",
                data: Data(stream.utf8)
            )
        }

        var events: [ChatStreamEvent] = []
        try await ChatStreamClient(apiClient: secured.client).consumeThreadStream(
            workspaceID: "alpha",
            threadID: "thread-a",
            request: ChatStreamRequest(message: "hello", clientTurnID: "turn-44")
        ) { event in
            events.append(event)
        }

        XCTAssertEqual(
            events,
            [
                .threadRename(title: "宏观政策更新"),
                .assistantText(
                    id: "reply-title",
                    text: "流式回答",
                    replaces: false,
                    closes: false
                ),
                .finalized(
                    chatID: 44,
                    publicChatID: "public-44",
                    clientTurnID: "turn-44"
                ),
            ]
        )
    }

    @MainActor
    func testChatStreamCarriesAtomicEditContextAndParsesEditHandshake() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let stream = """
        data: {"type":"editSessionReady","sourceActionId":"edit-17","startingChatId":17,"close":false}

        data: {"type":"editHistoryTruncated","sourceActionId":"edit-17","startingChatId":17,"close":false}

        data: {"uuid":"reply-17","type":"textResponseChunk","textResponse":"新回答","close":false}

        data: {"uuid":"reply-17","type":"finalizeResponseStream","chatId":18,"publicChatId":"public-18","clientTurnId":"turn-17","close":true}

        """
        AthenaTestURLProtocol.handler = { request in
            let body = try XCTUnwrap(Self.bodyData(for: request))
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: body) as? [String: Any]
            )
            let editContext = try XCTUnwrap(object["editContext"] as? [String: Any])
            XCTAssertEqual(editContext["startingChatId"] as? Int, 17)
            XCTAssertEqual(editContext["sourceActionId"] as? String, "edit-17")
            return Self.response(
                for: request,
                contentType: "text/event-stream",
                data: Data(stream.utf8)
            )
        }

        var events: [ChatStreamEvent] = []
        try await ChatStreamClient(apiClient: secured.client).consumeThreadStream(
            workspaceID: "alpha",
            threadID: "thread-a",
            request: ChatStreamRequest(
                message: "edited",
                clientTurnID: "turn-17",
                editContext: ChatStreamEditContext(
                    startingChatId: 17,
                    sourceActionId: "edit-17"
                )
            )
        ) { event in
            events.append(event)
        }

        XCTAssertEqual(
            events,
            [
                .editSessionReady(sourceActionID: "edit-17", startingChatID: 17),
                .editHistoryTruncated(sourceActionID: "edit-17", startingChatID: 17),
                .assistantText(
                    id: "reply-17",
                    text: "新回答",
                    replaces: false,
                    closes: false
                ),
                .finalized(
                    chatID: 18,
                    publicChatID: "public-18",
                    clientTurnID: "turn-17"
                ),
            ]
        )
    }

    @MainActor
    func testChatStreamCarriesRegenerateContextAndParsesReplacementHandshake() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let stream = """
        data: {"type":"regenerateSessionReady","sourceActionId":"regen-17","targetChatId":17,"close":false}

        data: {"type":"regenerateTurnDeleted","sourceActionId":"regen-17","targetChatId":17,"close":false}

        data: {"uuid":"regen-reply","type":"textResponseChunk","textResponse":"新回答","close":false}

        data: {"uuid":"regen-reply","type":"finalizeResponseStream","chatId":18,"publicChatId":"public-18","clientTurnId":"turn-regen","close":true}

        """
        AthenaTestURLProtocol.handler = { request in
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(
                    with: try XCTUnwrap(Self.bodyData(for: request))
                ) as? [String: Any]
            )
            let context = try XCTUnwrap(object["regenerateContext"] as? [String: Any])
            XCTAssertEqual(context["targetChatId"] as? Int, 17)
            XCTAssertEqual(context["sourceActionId"] as? String, "regen-17")
            return Self.response(
                for: request,
                contentType: "text/event-stream",
                data: Data(stream.utf8)
            )
        }

        var events: [ChatStreamEvent] = []
        try await ChatStreamClient(apiClient: secured.client).consumeThreadStream(
            workspaceID: "alpha",
            threadID: "thread-a",
            request: ChatStreamRequest(
                message: "original",
                clientTurnID: "turn-regen",
                regenerateContext: ChatStreamRegenerateContext(
                    targetChatId: 17,
                    sourceActionId: "regen-17"
                )
            )
        ) { events.append($0) }

        XCTAssertEqual(
            events,
            [
                .regenerateSessionReady(sourceActionID: "regen-17", targetChatID: 17),
                .regenerateTurnDeleted(sourceActionID: "regen-17", targetChatID: 17),
                .assistantText(
                    id: "regen-reply",
                    text: "新回答",
                    replaces: false,
                    closes: false
                ),
                .finalized(
                    chatID: 18,
                    publicChatID: "public-18",
                    clientTurnID: "turn-regen"
                ),
            ]
        )
    }

    func testChatReconciliationKeepsCanonicalTurnOrderAndPendingOverlay() {
        let authoritative = [
            AthenaChatMessage(id: "a2", role: .assistant, text: "A2", chatID: 2, sentAt: 20),
            AthenaChatMessage(id: "u1", role: .user, text: "U1", chatID: 1, sentAt: 10),
            AthenaChatMessage(id: "a1", role: .assistant, text: "A1", chatID: 1, sentAt: 10),
            AthenaChatMessage(id: "u2", role: .user, text: "U2", chatID: 2, sentAt: 20),
        ]
        let pending = AthenaChatMessage(
            id: "local-u3",
            role: .user,
            text: "U3",
            sentAt: 30,
            clientTurnID: "turn-3",
            deliveryState: .pending
        )

        let merged = ChatMessageReconciler.mergeAuthoritative(
            authoritative,
            current: authoritative + [pending]
        )

        XCTAssertEqual(merged.map(\.text), ["U1", "A1", "U2", "A2", "U3"])
        XCTAssertEqual(merged.last?.deliveryState, .pending)
    }

    func testChatReconciliationReplacesMatchingOptimisticTurn() {
        let optimistic = AthenaChatMessage(
            id: "local-user",
            role: .user,
            text: "Question",
            sentAt: 10,
            clientTurnID: "turn-1",
            deliveryState: .pending
        )
        let confirmed = AthenaChatMessage(
            id: "confirmed-user",
            role: .user,
            text: "Question",
            chatID: 9,
            sentAt: 10,
            clientTurnID: "turn-1",
            deliveryState: .confirmed
        )

        let merged = ChatMessageReconciler.mergeAuthoritative(
            [confirmed],
            current: [optimistic]
        )

        XCTAssertEqual(merged, [confirmed])
    }

    @MainActor
    func testSignedChatMutationContracts() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()
        var paths: [String] = []
        AthenaTestURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            paths.append(path)
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            switch path {
            case "/api/workspace/alpha/thread/thread-a/chat/public-7":
                return Self.response(for: request, json: #"{"success":true}"#)
            case "/api/workspace/alpha/thread/fork":
                return Self.response(
                    for: request,
                    json: #"{"newThreadSlug":"forked","newThread":{"id":13,"name":"Forked","slug":"forked","thread_type":"chat"}}"#
                )
            default:
                XCTFail("Unexpected chat mutation path: \(path)")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }

        let api = WorkspaceAPI(apiClient: secured.client)
        try await api.deleteChat(
            workspaceID: "alpha",
            threadID: "thread-a",
            chatID: 7,
            publicChatID: "public-7",
            sourceActionID: "delete-1"
        )
        let forked = try await api.forkChat(
            workspaceID: "alpha",
            threadID: "thread-a",
            chatID: 7,
            publicChatID: "public-7",
            sourceActionID: "fork-1"
        )

        XCTAssertEqual(forked.id, "forked")
        XCTAssertEqual(
            paths,
            [
                "/api/workspace/alpha/thread/thread-a/chat/public-7",
                "/api/workspace/alpha/thread/fork",
            ]
        )
    }

    @MainActor
    func testSignedIdempotentWorkspaceAndThreadCreationContracts() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()
        var paths: [String] = []

        AthenaTestURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            paths.append(path)
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            let body = try XCTUnwrap(Self.bodyData(for: request))
            let payload = try XCTUnwrap(
                JSONSerialization.jsonObject(with: body) as? [String: String]
            )
            switch path {
            case "/api/workspace/new":
                XCTAssertEqual(payload["name"], "Alpha")
                XCTAssertEqual(payload["sourceActionId"], "workspace-action")
                return Self.response(
                    for: request,
                    json: #"{"workspace":{"id":1,"name":"Alpha","slug":"alpha"},"message":null,"defaultThreads":{"threads":[{"id":11,"name":"Overview","slug":"overview","thread_type":"overview"},{"id":12,"name":"New Thread","slug":"thread-a","thread_type":"chat"}]}}"#
                )
            case "/api/workspace/alpha/thread/new":
                XCTAssertEqual(payload["sourceActionId"], "thread-action")
                return Self.response(
                    for: request,
                    json: #"{"thread":{"id":13,"name":"New Thread","slug":"thread-b","thread_type":"chat"},"message":null}"#
                )
            default:
                XCTFail("Unexpected path: \(path)")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }

        let api = WorkspaceAPI(apiClient: secured.client)
        let workspace = try await api.createWorkspace(
            name: "Alpha",
            sourceActionID: "workspace-action"
        )
        let thread = try await api.createThread(
            workspaceID: "alpha",
            sourceActionID: "thread-action"
        )

        XCTAssertEqual(workspace.id, "alpha")
        XCTAssertEqual(workspace.threads.map(\.id), ["overview", "thread-a"])
        XCTAssertEqual(thread.id, "thread-b")
        XCTAssertEqual(paths, ["/api/workspace/new", "/api/workspace/alpha/thread/new"])
    }

    @MainActor
    func testWorkspaceCenterLoadsRealWorkspaceThreadAndHistoryContracts() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()

        var protectedPaths: [String] = []
        AthenaTestURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if path != "/api/native-app/bootstrap" {
                protectedPaths.append(path)
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            }
            switch path {
            case "/api/system/user/state":
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"states":[{"namespace":"recent.navigation","scope":"global","version":"1","value":{"workspace":{"slug":"alpha","name":"Alpha"},"threadsByWorkspace":{"alpha":"thread-a"}}}]}
                    """
                )
            case "/api/workspaces":
                return Self.response(
                    for: request,
                    json: """
                    {"workspaces":[{"id":1,"name":"Alpha","slug":"alpha","chatModel":"deepseek-v4-pro"},{"id":2,"name":"Beta","slug":"beta"}]}
                    """
                )
            case "/api/workspace/alpha/threads":
                return Self.response(
                    for: request,
                    json: """
                    {"threads":[{"id":11,"name":"Thread A","title":"Thread A","slug":"thread-a","thread_type":"chat","chatModel":"deepseek-v4-flash"}]}
                    """
                )
            case "/api/workspace/alpha/thread/thread-a/bootstrap":
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "20")
                XCTAssertEqual(query.first(where: { $0.name == "detail" })?.value, "full")
                XCTAssertEqual(query.first(where: { $0.name == "priorityWindow" })?.value, "20")
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"workspace":{"id":1,"name":"Alpha","slug":"alpha","chatModel":"deepseek-v4-pro"},"thread":{"id":11,"name":"Thread A","title":"Thread A","slug":"thread-a","thread_type":"chat","chatModel":"deepseek-v4-flash"},"history":[{"role":"user","content":"Hello","chatId":7,"sentAt":100},{"role":"assistant","content":"Hi","chatId":7,"sentAt":100}],"page":{"limit":20,"olderBeforeChatId":7,"hasOlder":true,"hasNewer":false}}
                    """
                )
            case "/api/workspace/alpha/thread/thread-a/chats":
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                XCTAssertEqual(query.first(where: { $0.name == "limit" })?.value, "20")
                XCTAssertEqual(query.first(where: { $0.name == "beforeChatId" })?.value, "7")
                XCTAssertEqual(query.first(where: { $0.name == "detail" })?.value, "full")
                return Self.response(
                    for: request,
                    json: """
                    {"history":[{"role":"user","content":"Earlier question","chatId":5,"sentAt":50},{"role":"assistant","content":"Earlier answer","chatId":5,"sentAt":50}],"page":{"limit":20,"olderBeforeChatId":5,"hasOlder":false,"hasNewer":false}}
                    """
                )
            default:
                XCTFail("Unexpected request path: \(path)")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }

        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let localCache = LocalCache(rootURL: cacheRoot)
        let userState = UserStateSyncClient()
        let scheduler = TaskScheduler()
        let center = WorkspaceCenter(
            api: WorkspaceAPI(apiClient: secured.client),
            apiClient: secured.client,
            taskScheduler: scheduler,
            optimisticActionCenter: NativeOptimisticActionCenter(),
            recoveryCenter: NativeRecoveryCenter(),
            serverStateCache: ServerStateCache(
                scheduler: scheduler,
                secureStore: InMemorySecureValueStore(),
                persistentRootURL: cacheRoot
            ),
            localCache: localCache,
            userStateSyncClient: userState,
            source: .live
        )

        try await center.bootstrap(ownerScope: "user:test")

        XCTAssertEqual(center.workspaces.map(\.title), ["Alpha", "Beta"])
        XCTAssertEqual(center.workspaces.first?.threads.map(\.title), ["Thread A"])
        XCTAssertEqual(center.selectedThreadID, "thread-a")
        XCTAssertEqual(center.threadModel(for: "thread-a"), .flash)
        XCTAssertEqual(center.messages(for: "thread-a").map(\.text), ["Hello", "Hi"])
        XCTAssertTrue(center.historyState(for: "thread-a").hasOlder)
        await center.loadOlderHistory(for: "thread-a")
        XCTAssertEqual(
            center.messages(for: "thread-a").map(\.text),
            ["Earlier question", "Earlier answer", "Hello", "Hi"]
        )
        XCTAssertFalse(center.historyState(for: "thread-a").hasOlder)
        XCTAssertTrue(protectedPaths.contains("/api/workspaces"))

        let cachedWorkspaceReadCount = protectedPaths.filter { $0 == "/api/workspaces" }.count
        let cachedThreadReadCount = protectedPaths.filter {
            $0 == "/api/workspace/alpha/threads"
        }.count
        try await center.bootstrap(ownerScope: "user:test")
        XCTAssertEqual(
            protectedPaths.filter { $0 == "/api/workspaces" }.count,
            cachedWorkspaceReadCount
        )
        XCTAssertEqual(
            protectedPaths.filter { $0 == "/api/workspace/alpha/threads" }.count,
            cachedThreadReadCount
        )

        try await center.bootstrap(ownerScope: "user:test", refreshMode: .authoritative)
        XCTAssertEqual(
            protectedPaths.filter { $0 == "/api/workspaces" }.count,
            cachedWorkspaceReadCount + 1
        )
        XCTAssertEqual(
            protectedPaths.filter { $0 == "/api/workspace/alpha/threads" }.count,
            cachedThreadReadCount + 1
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testWorkspaceCenterEnqueuesUserBubbleBeforeStartingNetwork() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let localCache = LocalCache(rootURL: cacheRoot)
        let scheduler = TaskScheduler()
        let agent = AgentControlKit(
            events: [],
            apiClient: secured.client,
            taskScheduler: scheduler,
            requestSigningCenter: secured.signing,
            clientIdentityCenter: secured.identity,
            localCache: localCache
        )
        let center = WorkspaceCenter(
            api: WorkspaceAPI(apiClient: secured.client),
            apiClient: secured.client,
            chatStreamClient: ChatStreamClient(apiClient: secured.client),
            agentControlKit: agent,
            taskScheduler: scheduler,
            optimisticActionCenter: NativeOptimisticActionCenter(),
            recoveryCenter: NativeRecoveryCenter(),
            serverStateCache: ServerStateCache(
                scheduler: scheduler,
                secureStore: InMemorySecureValueStore(),
                persistentRootURL: cacheRoot
            ),
            localCache: localCache,
            userStateSyncClient: UserStateSyncClient(),
            source: .live
        )

        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/system/user/state":
                return Self.response(for: request, json: #"{"success":true,"states":[]}"#)
            case "/api/workspaces":
                return Self.response(
                    for: request,
                    json: #"{"workspaces":[{"id":1,"name":"Alpha","slug":"alpha"}]}"#
                )
            case "/api/workspace/alpha/threads":
                return Self.response(
                    for: request,
                    json: #"{"threads":[{"id":11,"name":"Thread A","slug":"thread-a","thread_type":"chat"}]}"#
                )
            case "/api/workspace/alpha/thread/thread-a/bootstrap":
                return Self.response(
                    for: request,
                    json: #"{"success":true,"workspace":{"id":1,"name":"Alpha","slug":"alpha"},"thread":{"id":11,"name":"Thread A","slug":"thread-a","thread_type":"chat"},"history":[{"role":"user","content":"Immediate","chatId":10,"publicChatId":"public-10","clientTurnId":"turn-placeholder","sentAt":100},{"role":"assistant","content":"Reply","chatId":10,"publicChatId":"public-10","clientTurnId":"turn-placeholder","sentAt":100}],"page":{"limit":20,"hasOlder":false}}"#
                )
            default:
                XCTFail("Unexpected bootstrap path: \(request.url?.path ?? "")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }
        try await center.bootstrap(ownerScope: "user:test")

        var streamRequestStarted = false
        var streamedTurnID: String?
        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/workspace/alpha/thread/thread-a/stream-chat":
                streamRequestStarted = true
                let turnID = try XCTUnwrap(
                    (JSONSerialization.jsonObject(
                        with: try XCTUnwrap(Self.bodyData(for: request))
                    ) as? [String: Any])?["clientTurnId"] as? String
                )
                streamedTurnID = turnID
                let stream = """
                data: {"action":"rename_thread","thread":{"slug":"thread-a","name":"即时对话标题","title":"即时对话标题","titleVersion":2,"animate":true}}

                data: {"uuid":"reply-chunk","type":"textResponseChunk","textResponse":"Partial","close":false}

                data: {"uuid":"reply-final","type":"fullTextResponse","textResponse":"Reply","close":true}

                data: {"uuid":"reply-final","type":"finalizeResponseStream","chatId":10,"publicChatId":"public-10","clientTurnId":"\(turnID)","close":true}

                """
                return Self.response(
                    for: request,
                    contentType: "text/event-stream",
                    data: Data(stream.utf8)
                )
            case "/api/workspace/alpha/thread/thread-a/bootstrap":
                let turnID = try XCTUnwrap(streamedTurnID)
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"workspace":{"id":1,"name":"Alpha","slug":"alpha"},"thread":{"id":11,"name":"即时对话标题","title":"即时对话标题","slug":"thread-a","thread_type":"chat"},"history":[{"role":"user","content":"Immediate","chatId":10,"publicChatId":"public-10","clientTurnId":"\(turnID)","sentAt":100},{"role":"assistant","content":"Reply","chatId":10,"publicChatId":"public-10","clientTurnId":"\(turnID)","sentAt":100}],"page":{"limit":20,"hasOlder":false}}
                    """
                )
            default:
                XCTFail("Unexpected send path: \(request.url?.path ?? "")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }

        XCTAssertTrue(center.enqueueMessage("Immediate", to: "thread-a"))
        XCTAssertFalse(streamRequestStarted)
        XCTAssertEqual(center.messages(for: "thread-a").last?.text, "Immediate")
        XCTAssertEqual(center.messages(for: "thread-a").last?.deliveryState, .pending)

        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(streamRequestStarted)
        XCTAssertEqual(center.syncMetadata(for: "thread-a")?.title, "即时对话标题")
        XCTAssertEqual(center.messages(for: "thread-a").map(\.text), ["Immediate", "Reply"])
        XCTAssertTrue(center.messages(for: "thread-a").allSatisfy { $0.deliveryState == .confirmed })
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testAgentIgnoresUserRootEchoAndWaitsForAuthoritativeFinalization() async {
        let kit = AgentControlKit(events: [])
        var finalized: AgentSessionSnapshot?
        kit.onSessionFinalized = { finalized = $0 }
        await kit.startSession(
            invocationID: "invocation-direction",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-direction"
        )

        kit.applySocketEventData(
            Data(
                #"{"seq":1,"to":"@agent","from":"USER","content":"original user input"}"#.utf8
            ),
            invocationID: "invocation-direction"
        )

        XCTAssertEqual(kit.sessions.first?.assistantText, "")
        XCTAssertNil(finalized)

        kit.applySocketEventData(
            Data(
                #"{"seq":2,"to":"USER","from":"@agent","content":"assistant answer","state":"success"}"#.utf8
            ),
            invocationID: "invocation-direction"
        )

        XCTAssertEqual(kit.sessions.first?.assistantText, "assistant answer")
        XCTAssertNil(finalized)

        kit.applySocketEventData(
            Data(
                #"{"seq":3,"type":"chatId","chatId":72,"publicChatId":"public-72","clientTurnId":"turn-direction"}"#.utf8
            ),
            invocationID: "invocation-direction"
        )

        XCTAssertEqual(finalized?.assistantText, "assistant answer")
        XCTAssertEqual(finalized?.finalChatID, 72)
    }

    func testAgentInlineHidesWhenAuthoritativeFinalAnswerIsInHistory() {
        let session = AgentSessionSnapshot(
            invocationID: "invocation-inline",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-inline",
            phase: .finalized,
            lastEventSequence: 5,
            retryCount: 0,
            assistantText: "same answer",
            finalChatID: 72,
            finalPublicChatID: "public-72",
            events: [],
            updatedAt: Date()
        )
        let authoritative = AthenaChatMessage(
            id: "thread-a:72:assistant",
            role: .assistant,
            text: "same answer",
            chatID: 72,
            publicChatID: "public-72",
            clientTurnID: "turn-inline",
            deliveryState: .confirmed
        )

        XCTAssertFalse(
            AgentInlinePresentationPolicy.shouldRender(
                session: session,
                messages: [authoritative]
            )
        )
        XCTAssertTrue(
            AgentInlinePresentationPolicy.shouldRender(
                session: session,
                messages: []
            )
        )
    }

    @MainActor
    func testWorkspaceCenterRestoresBackgroundCompletedChatFromServerState() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let localCache = LocalCache(rootURL: cacheRoot)
        let scheduler = TaskScheduler()
        let agent = AgentControlKit(
            events: [],
            apiClient: secured.client,
            taskScheduler: scheduler,
            requestSigningCenter: secured.signing,
            clientIdentityCenter: secured.identity,
            localCache: localCache
        )
        let center = WorkspaceCenter(
            api: WorkspaceAPI(apiClient: secured.client),
            apiClient: secured.client,
            chatStreamClient: ChatStreamClient(apiClient: secured.client),
            agentControlKit: agent,
            taskScheduler: scheduler,
            optimisticActionCenter: NativeOptimisticActionCenter(),
            recoveryCenter: NativeRecoveryCenter(),
            serverStateCache: ServerStateCache(
                scheduler: scheduler,
                secureStore: InMemorySecureValueStore(),
                persistentRootURL: cacheRoot
            ),
            localCache: localCache,
            userStateSyncClient: UserStateSyncClient(),
            source: .live
        )
        var historyRequestCount = 0
        var stateRequestCount = 0
        var observationRequestCount = 0
        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/system/user/state":
                return Self.response(for: request, json: #"{"success":true,"states":[]}"#)
            case "/api/workspaces":
                return Self.response(
                    for: request,
                    json: #"{"workspaces":[{"id":1,"name":"Alpha","slug":"alpha"}]}"#
                )
            case "/api/workspace/alpha/threads":
                return Self.response(
                    for: request,
                    json: #"{"threads":[{"id":11,"name":"Thread A","slug":"thread-a","thread_type":"chat"}]}"#
                )
            case "/api/workspace/alpha/thread/thread-a/bootstrap":
                historyRequestCount += 1
                let history = historyRequestCount == 1
                    ? #"[{"role":"user","content":"Background test","clientTurnId":"turn-background","sentAt":100}]"#
                    : #"[{"role":"user","content":"Background test","chatId":88,"publicChatId":"public-88","clientTurnId":"turn-background","sentAt":100},{"role":"assistant","content":"Completed while suspended","chatId":88,"publicChatId":"public-88","clientTurnId":"turn-background","sentAt":101}]"#
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"workspace":{"id":1,"name":"Alpha","slug":"alpha"},"thread":{"id":11,"name":"Thread A","slug":"thread-a","thread_type":"chat"},"history":\(history),"page":{"limit":20,"hasOlder":false}}
                    """
                )
            case "/api/workspace/alpha/thread/thread-a/chat-runs/turn-background/state":
                stateRequestCount += 1
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"run":{"kind":"chat","clientTurnId":"turn-background","status":"completed","revision":12,"terminal":true,"retryable":false,"finalChatId":88,"finalPublicChatId":"public-88","errorCode":null}}
                    """
                )
            case "/api/operations/client-chat-observations":
                observationRequestCount += 1
                return Self.response(
                    for: request,
                    json: #"{"success":true,"accepted":1}"#
                )
            default:
                XCTFail("Unexpected request: \(request.url?.absoluteString ?? "nil")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }

        try await center.bootstrap(ownerScope: "user:test")
        try localCache.saveChatStreamDescriptors(
            [
                PersistedChatStreamDescriptor(
                    workspaceID: "alpha",
                    threadID: "thread-a",
                    clientTurnID: "turn-background",
                    sendsToWorkspace: false,
                    lastRevision: 4,
                    updatedAt: Date()
                ),
            ],
            ownerScope: "user:test",
            apiBase: secured.client.configuration.normalizedBaseURL
        )

        await center.restorePersistedChatStreams()
        for _ in 0..<100 where center.hasRecoverableChatRun(in: "thread-a") {
            try await Task.sleep(for: .milliseconds(20))
        }

        XCTAssertFalse(center.hasRecoverableChatRun(in: "thread-a"))
        XCTAssertEqual(stateRequestCount, 1)
        XCTAssertEqual(observationRequestCount, 2)
        XCTAssertEqual(historyRequestCount, 2)
        XCTAssertEqual(
            center.messages(for: "thread-a").map(\.text),
            ["Background test", "Completed while suspended"]
        )
        XCTAssertTrue(
            localCache.loadChatStreamDescriptors(
                ownerScope: "user:test",
                apiBase: secured.client.configuration.normalizedBaseURL
            ).isEmpty
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testWorkspaceCenterKeepsAtomicEditLocalUntilCommitAndStreamsReplacement() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let localCache = LocalCache(rootURL: cacheRoot)
        let scheduler = TaskScheduler()
        let agent = AgentControlKit(
            events: [],
            apiClient: secured.client,
            taskScheduler: scheduler,
            requestSigningCenter: secured.signing,
            clientIdentityCenter: secured.identity,
            localCache: localCache
        )
        let center = WorkspaceCenter(
            api: WorkspaceAPI(apiClient: secured.client),
            apiClient: secured.client,
            chatStreamClient: ChatStreamClient(apiClient: secured.client),
            agentControlKit: agent,
            taskScheduler: scheduler,
            optimisticActionCenter: NativeOptimisticActionCenter(),
            recoveryCenter: NativeRecoveryCenter(),
            serverStateCache: ServerStateCache(
                scheduler: scheduler,
                secureStore: InMemorySecureValueStore(),
                persistentRootURL: cacheRoot
            ),
            localCache: localCache,
            userStateSyncClient: UserStateSyncClient(),
            source: .live
        )

        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/system/user/state":
                return Self.response(for: request, json: #"{"success":true,"states":[]}"#)
            case "/api/workspaces":
                return Self.response(
                    for: request,
                    json: #"{"workspaces":[{"id":1,"name":"Alpha","slug":"alpha"}]}"#
                )
            case "/api/workspace/alpha/threads":
                return Self.response(
                    for: request,
                    json: #"{"threads":[{"id":11,"name":"Thread A","slug":"thread-a","thread_type":"chat"}]}"#
                )
            case "/api/workspace/alpha/thread/thread-a/bootstrap":
                return Self.response(
                    for: request,
                    json: #"{"success":true,"workspace":{"id":1,"name":"Alpha","slug":"alpha"},"thread":{"id":11,"name":"Thread A","slug":"thread-a","thread_type":"chat"},"history":[{"role":"user","content":"Earlier","chatId":10,"publicChatId":"public-10","sentAt":100},{"role":"assistant","content":"Earlier reply","chatId":10,"publicChatId":"public-10","sentAt":101},{"role":"user","content":"Original","chatId":11,"publicChatId":"public-11","sentAt":102},{"role":"assistant","content":"Original reply","chatId":11,"publicChatId":"public-11","sentAt":103}],"page":{"limit":20,"hasOlder":false}}"#
                )
            default:
                XCTFail("Unexpected bootstrap path: \(request.url?.path ?? "")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }
        try await center.bootstrap(ownerScope: "user:test")

        let originalMessages = center.messages(for: "thread-a")
        let editableMessage = try XCTUnwrap(
            originalMessages.first { $0.role == .user && $0.chatID == 11 }
        )
        var postBootstrapRequestCount = 0

        XCTAssertTrue(center.beginChatEdit(messageID: editableMessage.id, in: "thread-a"))
        XCTAssertEqual(center.messages(for: "thread-a"), originalMessages)
        XCTAssertEqual(
            center.messagesForDisplay(in: "thread-a").map(\.text),
            ["Earlier", "Earlier reply"]
        )
        XCTAssertEqual(postBootstrapRequestCount, 0)

        center.cancelChatEdit(in: "thread-a")
        XCTAssertNil(center.chatEditSession)
        XCTAssertEqual(center.messagesForDisplay(in: "thread-a"), originalMessages)

        var streamedTurnID: String?
        AthenaTestURLProtocol.handler = { request in
            postBootstrapRequestCount += 1
            switch request.url?.path {
            case "/api/workspace/alpha/thread/thread-a/stream-chat":
                let body = try XCTUnwrap(Self.bodyData(for: request))
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: body) as? [String: Any]
                )
                let turnID = try XCTUnwrap(object["clientTurnId"] as? String)
                let editContext = try XCTUnwrap(object["editContext"] as? [String: Any])
                XCTAssertEqual(editContext["startingChatId"] as? Int, 11)
                XCTAssertEqual(editContext["sourceActionId"] as? String, turnID)
                streamedTurnID = turnID
                let stream = """
                data: {"type":"editSessionReady","sourceActionId":"\(turnID)","startingChatId":11,"close":false}

                data: {"type":"editHistoryTruncated","sourceActionId":"\(turnID)","startingChatId":11,"close":false}

                data: {"uuid":"edited-reply","type":"textResponseChunk","textResponse":"Edited reply","close":false}

                data: {"uuid":"edited-reply","type":"finalizeResponseStream","chatId":12,"publicChatId":"public-12","clientTurnId":"\(turnID)","close":true}

                """
                return Self.response(
                    for: request,
                    contentType: "text/event-stream",
                    data: Data(stream.utf8)
                )
            case "/api/workspace/alpha/thread/thread-a/bootstrap":
                let turnID = try XCTUnwrap(streamedTurnID)
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"workspace":{"id":1,"name":"Alpha","slug":"alpha"},"thread":{"id":11,"name":"Thread A","slug":"thread-a","thread_type":"chat"},"history":[{"role":"user","content":"Earlier","chatId":10,"publicChatId":"public-10","sentAt":100},{"role":"assistant","content":"Earlier reply","chatId":10,"publicChatId":"public-10","sentAt":101},{"role":"user","content":"Edited","chatId":12,"publicChatId":"public-12","clientTurnId":"\(turnID)","sentAt":104},{"role":"assistant","content":"Edited reply","chatId":12,"publicChatId":"public-12","clientTurnId":"\(turnID)","sentAt":105}],"page":{"limit":20,"hasOlder":false}}
                    """
                )
            default:
                XCTFail("Unexpected edit path: \(request.url?.path ?? "")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }

        XCTAssertTrue(center.beginChatEdit(messageID: editableMessage.id, in: "thread-a"))
        XCTAssertTrue(center.commitChatEdit("Edited", in: "thread-a"))
        XCTAssertEqual(
            center.messages(for: "thread-a").map(\.text),
            ["Earlier", "Earlier reply", "Edited"]
        )
        XCTAssertEqual(center.messages(for: "thread-a").last?.deliveryState, .pending)

        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(
            center.messages(for: "thread-a").map(\.text),
            ["Earlier", "Earlier reply", "Edited", "Edited reply"]
        )
        XCTAssertTrue(
            center.messages(for: "thread-a").allSatisfy { $0.deliveryState == .confirmed }
        )
        XCTAssertNil(center.chatEditSession)
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testServerStateCacheDeduplicatesConcurrentFetches() async throws {
        let cache = ServerStateCache()
        let fetchCount = InvocationCounter()
        let firstFetchStarted = expectation(description: "first cache fetch started")

        let first = Task { @MainActor in
            try await cache.load(
                Int.self,
                key: "workspaces",
                ownerScope: "user:1",
                ttl: 30
            ) {
                await fetchCount.increment()
                firstFetchStarted.fulfill()
                try await Task.sleep(for: .milliseconds(20))
                return 42
            }
        }
        await fulfillment(of: [firstFetchStarted], timeout: 1)

        async let second: Int = cache.load(
            Int.self,
            key: "workspaces",
            ownerScope: "user:1",
            ttl: 30
        ) {
            await fetchCount.increment()
            return 99
        }

        let values = try await [first.value, second]
        XCTAssertEqual(values, [42, 42])
        let invocationCount = await fetchCount.value
        XCTAssertEqual(invocationCount, 1)
    }

    @MainActor
    func testServerStateCacheDoesNotCommitSupersededFetch() async throws {
        let scheduler = TaskScheduler()
        let cache = ServerStateCache(scheduler: scheduler)
        let load = Task {
            try await cache.load(
                Int.self,
                key: "workspace:alpha:threads",
                ownerScope: "user:1",
                ttl: 30,
                task: AthenaTaskDescriptor(
                    label: "threads",
                    priority: .p1,
                    scope: AthenaTaskScope(owner: "user:1", workspaceID: "alpha")
                )
            ) {
                try await Task.sleep(for: .seconds(5))
                return 42
            }
        }

        try await Task.sleep(for: .milliseconds(20))
        await cache.markStale(key: "workspace:alpha:threads", ownerScope: "user:1")

        do {
            _ = try await load.value
            XCTFail("Expected superseded fetch to be cancelled")
        } catch {
            XCTAssertTrue(error is CancellationError || error is AthenaTaskSchedulerError)
        }
        let cached: Int? = cache.cachedValue(
            Int.self,
            key: "workspace:alpha:threads",
            ownerScope: "user:1",
            allowExpired: true
        )
        XCTAssertNil(cached)
    }

    @MainActor
    func testServerStateCachePersistsRecentHistoryEncrypted() async throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let secureStore = InMemorySecureValueStore()
        let apiBase = URL(string: "https://athena.test")!
        let owner = "user:7"
        let key = "workspace:alpha:thread:thread-a:history:latest"
        let cachedText = "private cached conversation"
        let cache = ServerStateCache(
            secureStore: secureStore,
            persistentRootURL: cacheRoot
        )

        let value = try await cache.load(
            String.self,
            key: key,
            ownerScope: owner,
            apiBase: apiBase,
            policy: .latestThreadHistory(threadID: "thread-a"),
            task: AthenaTaskDescriptor(
                label: "history",
                scope: AthenaTaskScope(owner: owner, workspaceID: "alpha", threadID: "thread-a")
            )
        ) {
            cachedText
        }
        XCTAssertEqual(value, cachedText)

        let directory = cacheRoot.appendingPathComponent("Athena/AuthenticatedServerState")
        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )
        let encrypted = try Data(contentsOf: try XCTUnwrap(files.first))
        XCTAssertFalse(String(decoding: encrypted, as: UTF8.self).contains(cachedText))

        let restoredCache = ServerStateCache(
            secureStore: secureStore,
            persistentRootURL: cacheRoot
        )
        let fetchCount = InvocationCounter()
        let restored = try await restoredCache.load(
            String.self,
            key: key,
            ownerScope: owner,
            apiBase: apiBase,
            policy: .latestThreadHistory(threadID: "thread-a")
        ) {
            await fetchCount.increment()
            return "network"
        }
        XCTAssertEqual(restored, cachedText)
        let restoredFetchCount = await fetchCount.value
        XCTAssertEqual(restoredFetchCount, 0)
        let snapshot = await restoredCache.snapshot(ownerScope: owner, apiBase: apiBase)
        XCTAssertEqual(snapshot.persistentEntryCount, 1)
        XCTAssertLessThanOrEqual(
            snapshot.persistentByteCount,
            PersistentServerStateStore.defaultMaximumBytes
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testServerStateCacheRetainsOnlyMostRecentThreadWorkingSet() async throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let secureStore = InMemorySecureValueStore()
        let apiBase = URL(string: "https://athena.test")!
        let owner = "user:7"
        let cache = ServerStateCache(
            secureStore: secureStore,
            persistentRootURL: cacheRoot,
            maximumRecentThreads: 2
        )

        for index in 0..<3 {
            let threadID = "thread-\(index)"
            _ = try await cache.set(
                "history-\(index)",
                key: "history:\(threadID):latest",
                ownerScope: owner,
                apiBase: apiBase,
                policy: .latestThreadHistory(threadID: threadID),
                scope: AthenaTaskScope(owner: owner, threadID: threadID)
            )
            try await Task.sleep(for: .milliseconds(5))
        }

        let restoredCache = ServerStateCache(
            secureStore: secureStore,
            persistentRootURL: cacheRoot,
            maximumRecentThreads: 2
        )
        let oldest: String? = await restoredCache.cachedValue(
            String.self,
            key: "history:thread-0:latest",
            ownerScope: owner,
            apiBase: apiBase,
            allowExpired: true
        )
        let middle: String? = await restoredCache.cachedValue(
            String.self,
            key: "history:thread-1:latest",
            ownerScope: owner,
            apiBase: apiBase,
            allowExpired: true
        )
        let newest: String? = await restoredCache.cachedValue(
            String.self,
            key: "history:thread-2:latest",
            ownerScope: owner,
            apiBase: apiBase,
            allowExpired: true
        )
        XCTAssertNil(oldest)
        XCTAssertEqual(middle, "history-1")
        XCTAssertEqual(newest, "history-2")
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testServerStateCacheBatchPersistsWithOneArchiveWrite() async throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let secureStore = InMemorySecureValueStore()
        let apiBase = URL(string: "https://athena.test")!
        let owner = "user:batch"
        let cache = ServerStateCache(
            secureStore: secureStore,
            persistentRootURL: cacheRoot
        )
        let items = (0..<3).map { index in
            ServerStateCacheBatchItem(
                value: "node-\(index)",
                key: "sync.v2.node.\(index)",
                policy: .recentNavigation,
                scope: AthenaTaskScope(owner: owner, route: "sync-v2")
            )
        }

        try await cache.setMany(items, ownerScope: owner, apiBase: apiBase)

        let snapshot = await cache.snapshot(ownerScope: owner, apiBase: apiBase)
        XCTAssertEqual(snapshot.persistentEntryCount, 3)
        XCTAssertEqual(snapshot.archiveWriteCount, 1)
        let restoredCache = ServerStateCache(
            secureStore: secureStore,
            persistentRootURL: cacheRoot
        )
        for index in 0..<3 {
            let value = await restoredCache.cachedValue(
                String.self,
                key: "sync.v2.node.\(index)",
                ownerScope: owner,
                apiBase: apiBase,
                allowExpired: true
            )
            XCTAssertEqual(value, "node-\(index)")
        }
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testServerStateCacheScopeInvalidationKeepsStaleFallbackUntilRemoval() async throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let secureStore = InMemorySecureValueStore()
        let apiBase = URL(string: "https://athena.test")!
        let owner = "user:7"
        let scope = AthenaTaskScope(owner: owner, workspaceID: "alpha", threadID: "thread-a")
        let cache = ServerStateCache(
            secureStore: secureStore,
            persistentRootURL: cacheRoot
        )
        _ = try await cache.set(
            "cached",
            key: "history:thread-a:latest",
            ownerScope: owner,
            apiBase: apiBase,
            policy: .latestThreadHistory(threadID: "thread-a"),
            scope: scope
        )

        await cache.markScopeStale(scope, ownerScope: owner, apiBase: apiBase)
        let fresh: String? = cache.cachedValue(
            String.self,
            key: "history:thread-a:latest",
            ownerScope: owner
        )
        let fallback: String? = cache.cachedValue(
            String.self,
            key: "history:thread-a:latest",
            ownerScope: owner,
            allowExpired: true
        )
        XCTAssertNil(fresh)
        XCTAssertEqual(fallback, "cached")

        await cache.invalidateScope(scope, ownerScope: owner, apiBase: apiBase)
        let removed: String? = await cache.cachedValue(
            String.self,
            key: "history:thread-a:latest",
            ownerScope: owner,
            apiBase: apiBase,
            allowExpired: true
        )
        XCTAssertNil(removed)
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    func testAggressiveIOSCachePolicyBudgetsAreExplicit() {
        XCTAssertEqual(PersistentServerStateStore.defaultMaximumBytes, 64 * 1_024 * 1_024)
        XCTAssertEqual(PersistentServerStateStore.defaultMaximumRecentThreads, 30)
        XCTAssertEqual(ServerStateCachePolicy.workspaceList.retainFor, 180 * 24 * 60 * 60)
        XCTAssertEqual(ServerStateCachePolicy.workspaceList.freshFor, 15 * 24 * 60 * 60)
        XCTAssertEqual(ServerStateCachePolicy.threadList.freshFor, 15 * 24 * 60 * 60)
        XCTAssertEqual(ServerStateCachePolicy.accountProfile.freshFor, 180 * 24 * 60 * 60)
        XCTAssertEqual(ServerStateCachePolicy.accountProfile.retainFor, 180 * 24 * 60 * 60)
        XCTAssertEqual(
            ServerStateCachePolicy.latestThreadHistory(threadID: "thread").retainFor,
            30 * 24 * 60 * 60
        )
    }

    func testAvatarCropGeometryMapsViewportToOriginalPixels() {
        let rect = AvatarCropGeometry.pixelCropRect(
            viewportSize: CGSize(width: 200, height: 200),
            contentOffset: CGPoint(x: 100, y: 50),
            zoomScale: 0.5,
            imagePointSize: CGSize(width: 1_000, height: 800),
            imagePixelSize: CGSize(width: 4_000, height: 3_200)
        )

        XCTAssertEqual(rect, CGRect(x: 800, y: 400, width: 1_600, height: 1_600))
    }

    @MainActor
    func testAvatarUploadKeepsCachedAvatarUntilUnifiedSyncRefresh() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.signing.prepareDeviceKey()
        try secured.auth.storeToken("session-token")
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = ServerStateCache(
            secureStore: InMemorySecureValueStore(),
            persistentRootURL: cacheRoot
        )
        let ownerScope = "user:7"
        let originalAvatar = Data("old-avatar".utf8)
        let snapshot = AccountProfileSnapshot(
            identity: "7",
            userID: 7,
            username: "ios",
            email: "ios@athena.test",
            phone: nil,
            avatarData: originalAvatar,
            avatarResolved: true,
            cachedAt: Date()
        )
        _ = try await cache.set(
            snapshot,
            key: "account.profile:7",
            ownerScope: ownerScope,
            apiBase: secured.client.configuration.normalizedBaseURL,
            policy: .accountProfile,
            scope: AthenaTaskScope(owner: ownerScope, route: "account-profile")
        )
        let center = AccountProfileCenter(
            apiClient: secured.client,
            serverStateCache: cache,
            taskScheduler: TaskScheduler()
        )
        var unexpectedRefreshCount = 0
        AthenaTestURLProtocol.handler = { request in
            unexpectedRefreshCount += 1
            return Self.response(for: request, json: #"{"success":false}"#)
        }
        await center.start(
            ownerScope: ownerScope,
            user: AthenaUser(
                id: 7,
                username: "ios",
                role: "default",
                email: "ios@athena.test",
                phone: nil,
                displayName: nil,
                pfpFilename: "old.jpg"
            )
        )
        XCTAssertEqual(unexpectedRefreshCount, 0)
        var uploadCount = 0
        AthenaTestURLProtocol.handler = { request in
            uploadCount += 1
            XCTAssertEqual(request.url?.path, "/api/system/upload-pfp")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            XCTAssertTrue(
                request.value(forHTTPHeaderField: "Content-Type")?
                    .hasPrefix("multipart/form-data; boundary=") == true
            )
            return Self.response(for: request, json: #"{"success":true,"message":"uploaded"}"#)
        }

        try await center.uploadAvatar(Data("new-avatar".utf8))

        XCTAssertEqual(uploadCount, 1)
        XCTAssertEqual(center.avatarData, originalAvatar)
        XCTAssertEqual(center.status, .awaitingSync)
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testSignOutCacheResetRemovesAuthenticatedMetadata() throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = LocalCache(rootURL: cacheRoot)
        let apiBase = URL(string: "https://athena.test")!
        let snapshot = WorkspaceMetadataSnapshot(
            workspaces: [AthenaWorkspace(id: "private", title: "Private")],
            selectedWorkspaceID: "private",
            selectedThreadID: nil,
            savedAt: Date()
        )

        try cache.saveWorkspaceSnapshot(
            snapshot,
            ownerScope: "user:1",
            apiBase: apiBase
        )
        XCTAssertNotNil(
            cache.loadWorkspaceSnapshot(ownerScope: "user:1", apiBase: apiBase)
        )

        cache.clearAllWorkspaceSnapshots()

        XCTAssertNil(
            cache.loadWorkspaceSnapshot(ownerScope: "user:1", apiBase: apiBase)
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testLoginRetriesOneConnectionLossWithoutBypassingAuthentication() async throws {
        let secured = makeClient()
        var requestCount = 0
        AthenaTestURLProtocol.handler = { request in
            requestCount += 1
            XCTAssertEqual(request.url?.path, "/api/request-token")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            if requestCount == 1 {
                throw URLError(.networkConnectionLost)
            }
            return Self.response(
                for: request,
                json: #"{"valid":true,"token":"session-token","user":{"id":7,"username":"ios","role":"default","email":null},"message":null,"recoveryCodes":null}"#
            )
        }

        try await secured.auth.login(
            identifier: "ios",
            password: "password",
            using: secured.client
        )

        XCTAssertEqual(requestCount, 2)
        XCTAssertEqual(secured.auth.accessToken, "session-token")
        XCTAssertEqual(secured.client.lastTransportFailure?.path, "/api/request-token")
        XCTAssertEqual(secured.client.lastTransportFailure?.code, .networkConnectionLost)
    }

    @MainActor
    func testChatStreamDescriptorContainsOnlyRecoverableNonSecretMetadata() throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = LocalCache(rootURL: cacheRoot)
        let apiBase = URL(string: "https://athena.test")!
        let descriptor = PersistedChatStreamDescriptor(
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-1",
            sendsToWorkspace: false,
            lastRevision: 7,
            updatedAt: Date()
        )

        try cache.saveChatStreamDescriptors(
            [descriptor],
            ownerScope: "user:7",
            apiBase: apiBase
        )

        let files = try FileManager.default.contentsOfDirectory(
            at: cacheRoot.appendingPathComponent("Athena/AuthenticatedMetadata"),
            includingPropertiesForKeys: nil
        )
        let file = try XCTUnwrap(files.first { $0.lastPathComponent.hasPrefix("chat-streams-") })
        let data = try Data(contentsOf: file)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(root["schemaVersion"] as? Int, 1)
        let runs = try XCTUnwrap(root["runs"] as? [[String: Any]])
        let keys = Set(try XCTUnwrap(runs.first).keys)
        XCTAssertEqual(
            keys,
            [
                "workspaceID", "threadID", "clientTurnID", "sendsToWorkspace",
                "lastRevision", "updatedAt",
            ]
        )

        let serialized = String(decoding: data, as: UTF8.self).lowercased()
        for forbidden in ["token", "prompt", "secret", "authorization", "message", "assistanttext"] {
            XCTAssertFalse(serialized.contains(forbidden), "Unexpected persisted key: \(forbidden)")
        }
        XCTAssertEqual(
            cache.loadChatStreamDescriptors(ownerScope: "user:7", apiBase: apiBase),
            [descriptor]
        )
        XCTAssertTrue(
            cache.loadChatStreamDescriptors(ownerScope: "user:8", apiBase: apiBase).isEmpty
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testAgentDescriptorContainsOnlyRecoverableNonSecretMetadata() throws {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = LocalCache(rootURL: cacheRoot)
        let apiBase = URL(string: "https://athena.test")!
        let descriptor = PersistedAgentSessionDescriptor(
            invocationID: "invocation-1",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-1",
            lastEventSequence: 42,
            phase: .reconnecting,
            updatedAt: Date()
        )

        try cache.saveAgentSessionDescriptors(
            [descriptor],
            ownerScope: "user:7",
            apiBase: apiBase
        )

        let files = try FileManager.default.contentsOfDirectory(
            at: cacheRoot.appendingPathComponent("Athena/AuthenticatedMetadata"),
            includingPropertiesForKeys: nil
        )
        let file = try XCTUnwrap(files.first { $0.lastPathComponent.hasPrefix("agent-sessions-") })
        let data = try Data(contentsOf: file)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(root["schemaVersion"] as? Int, 1)
        let sessions = try XCTUnwrap(root["sessions"] as? [[String: Any]])
        let keys = Set(try XCTUnwrap(sessions.first).keys)
        XCTAssertEqual(
            keys,
            [
                "invocationID", "workspaceID", "threadID", "clientTurnID",
                "lastEventSequence", "phase", "updatedAt",
            ]
        )

        let serialized = String(decoding: data, as: UTF8.self).lowercased()
        for forbidden in ["token", "prompt", "secret", "authorization", "message", "assistanttext"] {
            XCTAssertFalse(serialized.contains(forbidden), "Unexpected persisted key: \(forbidden)")
        }
        XCTAssertEqual(
            cache.loadAgentSessionDescriptors(ownerScope: "user:7", apiBase: apiBase),
            [descriptor]
        )
        XCTAssertTrue(
            cache.loadAgentSessionDescriptors(ownerScope: "user:8", apiBase: apiBase).isEmpty
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testAgentRestoreQueriesAuthenticatedServerStateBeforeClosingDescriptor() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = LocalCache(rootURL: cacheRoot)
        try cache.saveAgentSessionDescriptors(
            [
                PersistedAgentSessionDescriptor(
                    invocationID: "invocation-1",
                    workspaceID: "workspace-a",
                    threadID: "thread-a",
                    clientTurnID: "turn-1",
                    lastEventSequence: 12,
                    phase: .open,
                    updatedAt: Date()
                ),
            ],
            ownerScope: "user:7",
            apiBase: secured.client.configuration.normalizedBaseURL
        )
        var stateRequestCount = 0
        var observationRequestCount = 0
        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/agent-invocation/invocation-1/state":
                stateRequestCount += 1
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "Authorization"),
                    "Bearer session-token"
                )
                XCTAssertEqual(
                    request.value(forHTTPHeaderField: "X-Athena-Client-Id"),
                    secured.identity.clientID
                )
                return Self.response(
                    for: request,
                    json: #"{"success":true,"state":{"closed":true,"retryable":false,"latestSeq":18}}"#
                )
            case "/api/operations/client-chat-observations":
                observationRequestCount += 1
                return Self.response(
                    for: request,
                    json: #"{"success":true,"accepted":1}"#
                )
            default:
                XCTFail("Unexpected request: \(request.url?.absoluteString ?? "nil")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }
        let kit = AgentControlKit(
            events: [],
            apiClient: secured.client,
            taskScheduler: TaskScheduler(),
            requestSigningCenter: secured.signing,
            clientIdentityCenter: secured.identity,
            localCache: cache
        )

        await kit.restorePersistedSessions(ownerScope: "user:7")

        XCTAssertEqual(stateRequestCount, 1)
        XCTAssertEqual(observationRequestCount, 1)
        XCTAssertEqual(kit.sessions.first?.lastEventSequence, 18)
        XCTAssertEqual(kit.sessions.first?.phase, .closed)
        XCTAssertTrue(
            cache.loadAgentSessionDescriptors(
                ownerScope: "user:7",
                apiBase: secured.client.configuration.normalizedBaseURL
            ).isEmpty
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testAgentRestorePreservesTerminalFailureInsteadOfFinalizing() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = LocalCache(rootURL: cacheRoot)
        try cache.saveAgentSessionDescriptors(
            [
                PersistedAgentSessionDescriptor(
                    invocationID: "invocation-failed",
                    workspaceID: "workspace-a",
                    threadID: "thread-a",
                    clientTurnID: "turn-failed",
                    lastEventSequence: 4,
                    phase: .reconnecting,
                    updatedAt: Date()
                ),
            ],
            ownerScope: "user:7",
            apiBase: secured.client.configuration.normalizedBaseURL
        )
        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/agent-invocation/invocation-failed/state":
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"state":{"status":"failed","terminal":true,"closed":true,"retryable":false,"latestSeq":7,"errorCode":"provider_timeout","clientTurnId":"turn-failed"}}
                    """
                )
            case "/api/operations/client-chat-observations":
                return Self.response(
                    for: request,
                    json: #"{"success":true,"accepted":1}"#
                )
            default:
                XCTFail("Unexpected request: \(request.url?.absoluteString ?? "nil")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }
        let kit = AgentControlKit(
            events: [],
            apiClient: secured.client,
            taskScheduler: TaskScheduler(),
            requestSigningCenter: secured.signing,
            clientIdentityCenter: secured.identity,
            localCache: cache
        )

        await kit.restorePersistedSessions(ownerScope: "user:7")

        XCTAssertEqual(kit.sessions.first?.phase, .failed)
        XCTAssertEqual(kit.lastError, "provider_timeout")
        XCTAssertNil(kit.sessions.first?.finalChatID)
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testAgentRestoreFinalizesPersistedChatWhenProviderStateIsStillFinalizing() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let cache = LocalCache(rootURL: cacheRoot)
        try cache.saveAgentSessionDescriptors(
            [
                PersistedAgentSessionDescriptor(
                    invocationID: "invocation-finalizing",
                    workspaceID: "workspace-a",
                    threadID: "thread-a",
                    clientTurnID: "turn-finalizing",
                    lastEventSequence: 36,
                    phase: .reconnecting,
                    updatedAt: Date()
                ),
            ],
            ownerScope: "user:7",
            apiBase: secured.client.configuration.normalizedBaseURL
        )
        var observationRequestCount = 0
        AthenaTestURLProtocol.handler = { request in
            switch request.url?.path {
            case "/api/agent-invocation/invocation-finalizing/state":
                return Self.response(
                    for: request,
                    json: """
                    {"success":true,"state":{"status":"finalizing","terminal":true,"closed":false,"retryable":false,"latestSeq":2075,"finalChatId":2550,"finalPublicChatId":"public-2550","clientTurnId":"turn-finalizing"}}
                    """
                )
            case "/api/operations/client-chat-observations":
                observationRequestCount += 1
                return Self.response(
                    for: request,
                    json: #"{"success":true,"accepted":1}"#
                )
            default:
                XCTFail("Unexpected request: \(request.url?.absoluteString ?? "nil")")
                return Self.response(for: request, status: 404, json: "{}")
            }
        }
        let kit = AgentControlKit(
            events: [],
            apiClient: secured.client,
            taskScheduler: TaskScheduler(),
            requestSigningCenter: secured.signing,
            clientIdentityCenter: secured.identity,
            localCache: cache
        )
        var finalized: AgentSessionSnapshot?
        kit.onSessionFinalized = { finalized = $0 }

        await kit.restorePersistedSessions(ownerScope: "user:7")

        XCTAssertEqual(observationRequestCount, 2)
        XCTAssertEqual(kit.sessions.first?.phase, .finalized)
        XCTAssertEqual(finalized?.finalChatID, 2550)
        XCTAssertEqual(finalized?.finalPublicChatID, "public-2550")
        XCTAssertEqual(finalized?.clientTurnID, "turn-finalizing")
        XCTAssertTrue(
            cache.loadAgentSessionDescriptors(
                ownerScope: "user:7",
                apiBase: secured.client.configuration.normalizedBaseURL
            ).isEmpty
        )
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    @MainActor
    func testAgentReplayDoesNotAdvanceCursorBeforeMissingEventsAreApplied() async {
        let kit = AgentControlKit(events: [])
        var finalized: AgentSessionSnapshot?
        kit.onSessionFinalized = { finalized = $0 }
        await kit.startSession(
            invocationID: "invocation-replay",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-replay"
        )
        kit.sessions[0].lastEventSequence = 36

        kit.applySocketEventData(
            Data(#"{"type":"agentReplayStart","latestSeq":40}"#.utf8),
            invocationID: "invocation-replay"
        )
        kit.applySocketEventData(
            Data(#"{"seq":37,"type":"reportStreamEvent","content":{"type":"textResponseChunk","content":"missing tail"}}"#.utf8),
            invocationID: "invocation-replay"
        )
        kit.applySocketEventData(
            Data(#"{"seq":38,"content":"complete replayed answer"}"#.utf8),
            invocationID: "invocation-replay"
        )
        kit.applySocketEventData(
            Data(#"{"seq":39,"type":"reportStreamEvent","content":{"type":"chatId","chatId":77,"publicChatId":"public-77","clientTurnId":"turn-replay"}}"#.utf8),
            invocationID: "invocation-replay"
        )

        XCTAssertNil(finalized)
        XCTAssertEqual(kit.sessions.first?.assistantText, "complete replayed answer")
        XCTAssertEqual(kit.sessions.first?.lastEventSequence, 39)

        kit.applySocketEventData(
            Data(#"{"type":"agentReplayEnd","latestSeq":40}"#.utf8),
            invocationID: "invocation-replay"
        )

        XCTAssertEqual(finalized?.assistantText, "complete replayed answer")
        XCTAssertEqual(finalized?.finalChatID, 77)
        XCTAssertEqual(finalized?.finalPublicChatID, "public-77")
        XCTAssertEqual(finalized?.lastEventSequence, 40)
    }

    @MainActor
    func testAgentReducerWaitsForClarificationAckAndFinalizesStableClientTurn() async {
        let kit = AgentControlKit(events: [])
        var finalized: AgentSessionSnapshot?
        var renamedThread: (workspaceID: String, threadID: String, title: String)?
        kit.onSessionFinalized = { finalized = $0 }
        kit.onThreadRenamed = { workspaceID, threadID, title in
            renamedThread = (workspaceID, threadID, title)
        }
        await kit.startSession(
            invocationID: "invocation-reducer",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-agent"
        )

        kit.applySocketEventData(
            Data(#"{"seq":1,"type":"clarificationRequest","requestId":"clarify-1","questions":[{"id":"q1","question":"选择方式","options":["A","B","C"],"optionDescriptions":["推荐","备选","其他"]}],"allowSkip":true,"timeoutMs":30000}"#.utf8),
            invocationID: "invocation-reducer"
        )
        XCTAssertEqual(kit.sessions.first?.phase, .waitingOnInput)
        XCTAssertEqual(kit.sessions.first?.events.first?.requestID, "clarify-1")
        XCTAssertEqual(kit.sessions.first?.events.first?.questions.first?.options, ["A", "B", "C"])

        kit.applySocketEventData(
            Data(#"{"seq":2,"type":"clarificationResolved","requestId":"clarify-1"}"#.utf8),
            invocationID: "invocation-reducer"
        )
        XCTAssertTrue(kit.sessions.first?.events.isEmpty == true)
        XCTAssertEqual(kit.sessions.first?.phase, .open)

        kit.applySocketEventData(
            Data(#"{"seq":3,"type":"reportStreamEvent","content":{"type":"textResponseChunk","content":"流式回答","close":false}}"#.utf8),
            invocationID: "invocation-reducer"
        )
        kit.applySocketEventData(
            Data(#"{"seq":4,"type":"reportStreamEvent","content":{"type":"fullTextResponse","content":"最终回答"}}"#.utf8),
            invocationID: "invocation-reducer"
        )
        XCTAssertNil(finalized)
        kit.applySocketEventData(
            Data(#"{"seq":5,"type":"rename_thread","content":{"slug":"thread-a","name":"工具调用总结","title":"工具调用总结","titleVersion":2,"animate":true}}"#.utf8),
            invocationID: "invocation-reducer"
        )
        XCTAssertEqual(renamedThread?.workspaceID, "workspace-a")
        XCTAssertEqual(renamedThread?.threadID, "thread-a")
        XCTAssertEqual(renamedThread?.title, "工具调用总结")

        kit.applySocketEventData(
            Data(#"{"seq":6,"type":"reportStreamEvent","content":{"type":"toolCallInvocation","toolName":"web-search","content":"查询资料"}}"#.utf8),
            invocationID: "invocation-reducer"
        )
        kit.applySocketEventData(
            Data(#"{"seq":7,"type":"reportStreamEvent","content":{"type":"toolCallResult","toolName":"web-search","summary":"找到两条结果"}}"#.utf8),
            invocationID: "invocation-reducer"
        )
        XCTAssertTrue(kit.sessions.first?.events.contains(where: { $0.kind == .toolCall }) == true)
        XCTAssertTrue(kit.sessions.first?.events.contains(where: { $0.kind == .toolResult }) == true)

        kit.applySocketEventData(
            Data(#"{"seq":8,"type":"reportStreamEvent","content":{"type":"chatId","chatId":22,"publicChatId":"public-22","clientTurnId":"turn-agent"}}"#.utf8),
            invocationID: "invocation-reducer"
        )

        XCTAssertEqual(finalized?.clientTurnID, "turn-agent")
        XCTAssertEqual(finalized?.finalChatID, 22)
        XCTAssertEqual(finalized?.finalPublicChatID, "public-22")
        XCTAssertEqual(finalized?.assistantText, "最终回答")
    }

    @MainActor
    func testAgentFailureTerminatesGenerationAndReportsClientTurn() async {
        let kit = AgentControlKit(events: [])
        var failedSession: AgentSessionSnapshot?
        var failureMessage: String?
        kit.onSessionFailed = { session, message in
            failedSession = session
            failureMessage = message
        }
        await kit.startSession(
            invocationID: "invocation-failed",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-failed"
        )

        kit.applySocketEventData(
            Data(#"{"seq":1,"type":"wssFailure","content":"Market provider unavailable."}"#.utf8),
            invocationID: "invocation-failed"
        )

        XCTAssertEqual(kit.sessions.first?.phase, .failed)
        XCTAssertTrue(kit.sessions.first?.phase.isTerminal == true)
        XCTAssertEqual(failedSession?.clientTurnID, "turn-failed")
        XCTAssertEqual(failureMessage, "Market provider unavailable.")
    }

    @MainActor
    func testAgentIgnoresProvisionalUnknownToolFragments() async {
        let kit = AgentControlKit(events: [])
        await kit.startSession(
            invocationID: "invocation-tools",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-tools"
        )

        kit.applySocketEventData(
            Data(#"{"seq":1,"type":"reportStreamEvent","content":{"type":"toolCallInvocation","uuid":"tool-1","content":"Assembling Tool Call: crypto("}}"#.utf8),
            invocationID: "invocation-tools"
        )
        kit.applySocketEventData(
            Data(#"{"seq":2,"type":"reportStreamEvent","content":{"type":"toolCallInvocation","uuid":"tool-1","toolName":"crypto-market","phase":"ready","content":"Calling crypto-market."}}"#.utf8),
            invocationID: "invocation-tools"
        )

        let toolEvents = kit.sessions.first?.events.filter { $0.kind == .toolCall } ?? []
        XCTAssertEqual(toolEvents.count, 1)
        XCTAssertEqual(toolEvents.first?.title, "使用工具 · crypto-market")
    }

    @MainActor
    func testAgentStopUsesAuthenticatedSignedHTTPConfirmation() async throws {
        let secured = makeClient()
        _ = try secured.identity.prepare()
        try secured.auth.storeToken("session-token")
        try secured.signing.prepareDeviceKey()
        let kit = AgentControlKit(
            events: [],
            apiClient: secured.client,
            taskScheduler: nil,
            requestSigningCenter: secured.signing,
            clientIdentityCenter: secured.identity,
            localCache: nil
        )
        await kit.startSession(
            invocationID: "invocation-stop",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-stop"
        )
        AthenaTestURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/agent-invocation/invocation-stop/stop")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "X-Athena-Signature"))
            return Self.response(for: request, json: #"{"success":true,"closed":true}"#)
        }

        await kit.stop(invocationID: "invocation-stop")

        XCTAssertEqual(kit.sessions.first?.phase, .closed)
    }

    @MainActor
    func testAgentFinalReconcilesPendingUserBubbleBeforeHistoryRefresh() async {
        let cacheRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let scheduler = TaskScheduler()
        let pending = AthenaChatMessage(
            id: "local-turn-agent-user",
            role: .user,
            text: "agent request",
            clientTurnID: "turn-agent",
            deliveryState: .pending
        )
        let thread = AthenaThread(
            id: "thread-a",
            workspaceID: "workspace-a",
            title: "Thread A",
            messages: [pending]
        )
        let center = WorkspaceCenter(
            api: nil,
            apiClient: nil,
            taskScheduler: scheduler,
            optimisticActionCenter: NativeOptimisticActionCenter(),
            recoveryCenter: NativeRecoveryCenter(),
            serverStateCache: ServerStateCache(
                scheduler: scheduler,
                secureStore: InMemorySecureValueStore(),
                persistentRootURL: cacheRoot
            ),
            localCache: LocalCache(rootURL: cacheRoot),
            userStateSyncClient: UserStateSyncClient(),
            source: .live,
            workspaces: [
                AthenaWorkspace(id: "workspace-a", title: "Alpha", threads: [thread]),
            ],
            selectedThreadID: ""
        )
        let session = AgentSessionSnapshot(
            invocationID: "invocation-1",
            workspaceID: "workspace-a",
            threadID: "thread-a",
            clientTurnID: "turn-agent",
            phase: .finalized,
            lastEventSequence: 5,
            retryCount: 0,
            assistantText: "final answer",
            finalChatID: 22,
            finalPublicChatID: "public-22",
            events: [],
            updatedAt: Date()
        )
        center.sendingThreadIDs.insert("thread-a")
        center.sendErrorByThreadID["thread-a"] = "stale reconnect error"

        await center.reconcileFinalizedAgentSession(session)

        let confirmed = center.messages(for: "thread-a").first
        XCTAssertEqual(confirmed?.chatID, 22)
        XCTAssertEqual(confirmed?.publicChatID, "public-22")
        XCTAssertEqual(confirmed?.deliveryState, .confirmed)
        XCTAssertFalse(center.sendingThreadIDs.contains("thread-a"))
        XCTAssertNil(center.sendErrorByThreadID["thread-a"])
        try? FileManager.default.removeItem(at: cacheRoot)
    }

    func testNativeSyncReplayAcceptsStringResourceIdentifiers() throws {
        let response = try JSONDecoder().decode(
            NativeSyncReplayResponse.self,
            from: Data(
                #"""
                {
                  "success": true,
                  "events": [
                    {
                      "eventId": "event-a",
                      "type": "system.provider.updated",
                      "resource": {
                        "kind": "provider",
                        "id": "provider-a",
                        "publicId": "provider-a"
                      }
                    },
                    {
                      "eventId": "event-b",
                      "type": "thread.created",
                      "resource": {
                        "kind": "thread",
                        "id": "42"
                      }
                    }
                  ],
                  "nextEventId": "event-b",
                  "checkpointEventId": null,
                  "hasMore": false,
                  "requiresFullSync": false
                }
                """#.utf8
            )
        )

        XCTAssertNil(response.events[0].resource?.id)
        XCTAssertEqual(response.events[1].resource?.id, 42)
    }

    @MainActor
    private func makeClient(
        strictPostQuantum: Bool = true
    ) -> (
        client: APIClient,
        auth: AuthCenter,
        identity: ClientIdentityCenter,
        signing: RequestSigningCenter
    ) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AthenaTestURLProtocol.self]
        let client = APIClient(
            configuration: APIClientConfiguration(
                baseURL: URL(string: "https://athena.test")!,
                appVersion: "2.4.0",
                osVersion: "26.0",
                platform: "ios"
            ),
            session: URLSession(configuration: configuration),
            transientRetryDelaysNanoseconds: [0, 0, 0]
        )
        let store = InMemorySecureValueStore()
        let auth = AuthCenter(secureStore: store)
        let identity = ClientIdentityCenter(secureStore: store)
        let signing = RequestSigningCenter(
            secureStore: store,
            postQuantumTestSignatureProvider: strictPostQuantum
                ? { payload in
                    (
                        signature: Data(
                            repeating: UInt8(payload.count % 251),
                            count: 3_309
                        ),
                        publicKey: Data(repeating: 7, count: 1_952)
                    )
                }
                : nil
        )
        if strictPostQuantum {
            signing.applyBootstrap(
                NativeCompatibilityContract.bootstrap(
                    baseURL: URL(string: "https://athena.test")!
                )
            )
        }
        client.configureSecurity(
            authCenter: auth,
            clientIdentityCenter: identity,
            requestSigningCenter: signing
        )
        return (client, auth, identity, signing)
    }

    private static func response(
        for request: URLRequest,
        status: Int = 200,
        json: String
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(json.utf8))
    }

    private static func base64URLData(_ value: String) -> Data? {
        let standard = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = String(
            repeating: "=",
            count: (4 - standard.count % 4) % 4
        )
        return Data(base64Encoded: standard + padding)
    }

    private static func response(
        for request: URLRequest,
        status: Int = 200,
        contentType: String,
        data: Data
    ) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: nil,
            headerFields: ["Content-Type": contentType]
        )!
        return (response, data)
    }

    private static func bodyData(for request: URLRequest) -> Data? {
        if let body = request.httpBody {
            return body
        }
        guard let stream = request.httpBodyStream else {
            return nil
        }

        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 4_096
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }

        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: bufferSize)
            if count < 0 {
                return nil
            }
            if count == 0 {
                break
            }
            data.append(Data(bytes: buffer, count: count))
        }
        return data
    }
}
