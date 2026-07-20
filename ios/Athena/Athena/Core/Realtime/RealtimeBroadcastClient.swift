import Foundation
import Observation

private struct BroadcastSubscription: Encodable, Sendable {
    let channel: String?
    let visibility: String?
    let scope: [String: String]?
}

private struct BroadcastControl: Encodable, Sendable {
    let type: String
    let lastEventId: String?
    let subscriptions: [BroadcastSubscription]?
    let eventId: String?
}

private struct BroadcastEnvelope: Decodable {
    let type: String
    let event: NativeSyncEvent?
}

@MainActor
@Observable
final class RealtimeBroadcastClient {
    enum Status: Equatable {
        case disconnected
        case connecting
        case connected
        case reconnecting
    }

    typealias EventHandler = @MainActor (NativeSyncEvent) async throws -> Void

    var status: Status = .disconnected
    var webSocketPath = "/api/realtime/broadcast"
    var durableReplayAvailable = false

    private let apiClient: APIClient?
    private let requestSigningCenter: RequestSigningCenter?
    private let clientIdentityCenter: ClientIdentityCenter?
    private var runTask: Task<Void, Never>?
    private var socket: URLSessionWebSocketTask?
    private var shouldRun = false
    private var lastEventID: String?
    private var workspaceID: String?
    private var threadID: String?
    private var eventHandler: EventHandler?

    init(
        apiClient: APIClient? = nil,
        requestSigningCenter: RequestSigningCenter? = nil,
        clientIdentityCenter: ClientIdentityCenter? = nil
    ) {
        self.apiClient = apiClient
        self.requestSigningCenter = requestSigningCenter
        self.clientIdentityCenter = clientIdentityCenter
    }

    func applyBootstrap(_ bootstrap: NativeAppBootstrap?) {
        webSocketPath = bootstrap?.endpoints.broadcastWebSocketPath ?? "/api/realtime/broadcast"
        durableReplayAvailable = bootstrap?.features.broadcastDurableTransport ?? false
    }

    func start(
        lastEventID: String?,
        workspaceID: String?,
        threadID: String?,
        onEvent: @escaping EventHandler
    ) {
        self.lastEventID = lastEventID
        self.workspaceID = workspaceID
        self.threadID = threadID
        self.eventHandler = onEvent
        shouldRun = true
        guard runTask == nil else { return }
        runTask = Task { [weak self] in
            await self?.connectionLoop()
        }
    }

    func updateSubscription(workspaceID: String?, threadID: String?) async {
        self.workspaceID = workspaceID
        self.threadID = threadID
        guard let socket else { return }
        try? await send(
            BroadcastControl(
                type: "replaceSubscriptions",
                lastEventId: nil,
                subscriptions: subscriptions(),
                eventId: nil
            ),
            over: socket
        )
    }

    func stop() {
        shouldRun = false
        runTask?.cancel()
        runTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        status = .disconnected
    }

    private func connectionLoop() async {
        var retry = 0
        defer {
            runTask = nil
            socket = nil
            status = .disconnected
        }
        while shouldRun && !Task.isCancelled {
            do {
                status = retry == 0 ? .connecting : .reconnecting
                guard let apiClient else { throw APIClientError.invalidResponse }
                let nextSocket = try apiClient.makeAuthenticatedWebSocketTask(
                    path: webSocketPath,
                    queryItems: lastEventID.map {
                        [URLQueryItem(name: "lastEventId", value: $0)]
                    } ?? []
                )
                socket = nextSocket
                nextSocket.resume()
                try await send(
                    BroadcastControl(
                        type: lastEventID == nil ? "hello" : "resume",
                        lastEventId: lastEventID,
                        subscriptions: subscriptions(),
                        eventId: nil
                    ),
                    over: nextSocket
                )
                status = .connected
                retry = 0
                try await receiveLoop(nextSocket)
            } catch is CancellationError {
                return
            } catch {
                socket?.cancel(with: .abnormalClosure, reason: nil)
                socket = nil
                guard shouldRun && !Task.isCancelled else { return }
                status = .reconnecting
                retry = min(retry + 1, 5)
                let seconds = min(pow(2.0, Double(retry)), 30)
                try? await Task.sleep(for: .seconds(seconds))
            }
        }
    }

    private func receiveLoop(_ socket: URLSessionWebSocketTask) async throws {
        while shouldRun && !Task.isCancelled {
            let message = try await socket.receive()
            let data: Data
            switch message {
            case .data(let value): data = value
            case .string(let value): data = Data(value.utf8)
            @unknown default: continue
            }
            let envelope = try JSONDecoder().decode(BroadcastEnvelope.self, from: data)
            guard envelope.type == "broadcast.event", let event = envelope.event else {
                continue
            }
            try await eventHandler?(event)
            lastEventID = event.eventId
            try await send(
                BroadcastControl(
                    type: "ack",
                    lastEventId: nil,
                    subscriptions: nil,
                    eventId: event.eventId
                ),
                over: socket
            )
        }
    }

    private func send(_ control: BroadcastControl, over socket: URLSessionWebSocketTask) async throws {
        guard let apiClient,
              let requestSigningCenter,
              let clientIdentityCenter else {
            throw APIClientError.signingUnavailable
        }
        let httpURL = try apiClient.url(for: webSocketPath)
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            throw APIClientError.invalidURL(webSocketPath)
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        guard let url = components.url else {
            throw APIClientError.invalidURL(webSocketPath)
        }
        let data = try requestSigningCenter.signedWebSocketMessage(
            payload: control,
            url: url,
            clientID: clientIdentityCenter.clientID
        )
        guard let string = String(data: data, encoding: .utf8) else {
            throw APIClientError.invalidResponse
        }
        try await socket.send(.string(string))
    }

    private func subscriptions() -> [BroadcastSubscription] {
        var result = [
            BroadcastSubscription(channel: nil, visibility: "user", scope: nil),
            BroadcastSubscription(channel: "security", visibility: nil, scope: nil),
        ]
        if let workspaceID {
            result.append(
                BroadcastSubscription(
                    channel: nil,
                    visibility: "workspace",
                    scope: ["workspaceSlug": workspaceID]
                )
            )
        }
        if let workspaceID, let threadID {
            result.append(
                BroadcastSubscription(
                    channel: nil,
                    visibility: "thread",
                    scope: ["workspaceSlug": workspaceID, "threadSlug": threadID]
                )
            )
        }
        return result
    }
}
