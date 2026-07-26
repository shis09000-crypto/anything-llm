import Foundation
import ImageIO
import Observation
import UniformTypeIdentifiers

struct AccountProfileSnapshot: Codable, Equatable, Sendable {
    let identity: String
    let userID: Int?
    var username: String
    var email: String?
    var phone: String?
    var role: String?
    var bio: String?
    var avatarData: Data?
    var avatarResolved: Bool
    var cachedAt: Date

    static func placeholder(user: AthenaUser?) -> AccountProfileSnapshot {
        AccountProfileSnapshot(
            identity: user?.stableID ?? "single-user",
            userID: user?.id,
            username: user?.username?.trimmingCharacters(in: .whitespacesAndNewlines)
                .nonEmpty ?? "Athena",
            email: user?.email,
            phone: user?.phone,
            role: user?.role,
            bio: user?.bio,
            avatarData: nil,
            avatarResolved: false,
            cachedAt: Date()
        )
    }
}

private struct AccountRefreshUserResponse: Decodable {
    let success: Bool
    let user: AthenaUser?
    let message: String?
}

private struct AccountAvatarUploadResponse: Decodable {
    let message: String?
}

@MainActor
@Observable
final class AccountProfileCenter {
    enum Status: Equatable {
        case idle
        case loading
        case ready
        case uploading
        case awaitingSync
        case failed(String)
    }

    private let apiClient: APIClient
    private let serverStateCache: ServerStateCache
    private let taskScheduler: TaskScheduler
    private var ownerScope: String?
    private var authenticatedUser: AthenaUser?

    private(set) var profile: AccountProfileSnapshot?
    private(set) var status: Status = .idle

    var displayName: String {
        profile?.username.nonEmpty
            ?? authenticatedUser?.username?.nonEmpty
            ?? "Athena"
    }

    var email: String? { profile?.email ?? authenticatedUser?.email }
    var phone: String? { profile?.phone ?? authenticatedUser?.phone }
    var role: String? { profile?.role ?? authenticatedUser?.role }
    var bio: String? { profile?.bio ?? authenticatedUser?.bio }
    var avatarData: Data? { profile?.avatarData }

    init(
        apiClient: APIClient,
        serverStateCache: ServerStateCache,
        taskScheduler: TaskScheduler
    ) {
        self.apiClient = apiClient
        self.serverStateCache = serverStateCache
        self.taskScheduler = taskScheduler
    }

    @discardableResult
    func prepare(ownerScope: String, user: AthenaUser?) async -> Bool {
        self.ownerScope = ownerScope
        authenticatedUser = user
        let placeholder = AccountProfileSnapshot.placeholder(user: user)
        if profile?.identity != placeholder.identity {
            profile = placeholder
        }
        status = .loading

        if let cached: AccountProfileSnapshot = await serverStateCache.cachedValue(
            AccountProfileSnapshot.self,
            key: cacheKey(identity: placeholder.identity),
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        ) {
            profile = cached
            status = .ready
            return true
        }

        return false
    }

    func start(ownerScope: String, user: AthenaUser?) async {
        if await prepare(ownerScope: ownerScope, user: user) { return }
        await refreshAuthoritatively(changedFields: nil)
    }

    func refreshFromUnifiedSync(changedFields: [String]?) async {
        await refreshAuthoritatively(changedFields: changedFields)
    }

    func refreshForFullReconciliation() async {
        await refreshAuthoritatively(changedFields: nil)
    }

    func applySyncV2Profile(_ projection: NativeSyncV2ProfileProjection) async {
        guard let ownerScope else { return }
        let previous = profile ?? .placeholder(user: authenticatedUser)
        let previousAvatarFingerprint = authenticatedUser?.pfpFilename
        let projectedUser = AthenaUser(
            id: projection.id,
            authUserId: authenticatedUser?.authUserId,
            username: projection.username,
            role: authenticatedUser?.role,
            email: projection.email,
            phone: projection.phone,
            displayName: projection.displayName,
            pfpFilename: projection.pfpFilename,
            bio: projection.bio
        )
        authenticatedUser = projectedUser
        let next = AccountProfileSnapshot(
            identity: projectedUser.stableID,
            userID: projection.id,
            username: projection.username?.nonEmpty ?? previous.username,
            email: projection.email,
            phone: projection.phone,
            role: previous.role ?? authenticatedUser?.role,
            bio: projection.bio,
            avatarData: previous.avatarData,
            avatarResolved: previous.avatarResolved,
            cachedAt: Date()
        )
        profile = next
        _ = try? await serverStateCache.set(
            next,
            key: cacheKey(identity: next.identity),
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL,
            policy: .accountProfile,
            scope: profileScope(ownerScope: ownerScope, surface: "sync-v2-profile")
        )
        status = .ready
        if previousAvatarFingerprint != projection.pfpFilename {
            await refreshAuthoritatively(changedFields: ["pfpFilename"])
        }
    }

    func applyConfirmedBio(_ bio: String) async {
        guard let ownerScope else { return }
        var next = profile ?? .placeholder(user: authenticatedUser)
        next.bio = bio
        next.cachedAt = Date()
        profile = next
        _ = try? await serverStateCache.set(
            next,
            key: cacheKey(identity: next.identity),
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL,
            policy: .accountProfile,
            scope: profileScope(ownerScope: ownerScope, surface: "personalization")
        )
        status = .ready
    }

    func uploadAvatar(_ jpegData: Data) async throws {
        guard let ownerScope else {
            throw APIClientError.authenticationRequired
        }
        status = .uploading
        do {
            let boundary = "AthenaAvatar-\(UUID().uuidString)"
            let body = Self.multipartBody(
                data: jpegData,
                fieldName: "file",
                filename: "avatar.jpg",
                mimeType: "image/jpeg",
                boundary: boundary
            )
            _ = try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: "account:avatar-upload",
                    kind: "account-profile-write",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    resource: .upload,
                    scope: profileScope(ownerScope: ownerScope, surface: "avatar-upload"),
                    dedupeKey: "account:avatar-upload:\(ownerScope)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { [apiClient] context in
                try context.checkCancellation()
                let data = try await apiClient.requestData(
                    method: .post,
                    path: "/api/system/upload-pfp",
                    headers: [
                        "Accept": "application/json",
                        "Content-Type": "multipart/form-data; boundary=\(boundary)",
                    ],
                    body: body,
                    authorization: .required,
                    signing: .required,
                    retryOnConnectionLoss: true
                )
                return (try? JSONDecoder().decode(AccountAvatarUploadResponse.self, from: data))?.message
            }
            status = .awaitingSync
        } catch {
            status = .failed(error.localizedDescription)
            throw error
        }
    }

    func reset() {
        ownerScope = nil
        authenticatedUser = nil
        profile = nil
        status = .idle
    }

    func seedPreview(user: AthenaUser) {
        authenticatedUser = user
        profile = .placeholder(user: user)
        status = .ready
    }

    private func refreshAuthoritatively(changedFields: [String]?) async {
        guard let ownerScope else { return }
        let previous = profile ?? .placeholder(user: authenticatedUser)
        let shouldRefreshAvatar = changedFields == nil
            || changedFields?.contains("pfpFilename") == true
            || !previous.avatarResolved
        let shouldRefreshMetadata = changedFields == nil
            || changedFields?.contains(where: {
                ["username", "displayName", "email", "phone", "role", "bio"].contains($0)
            }) == true

        status = .loading
        do {
            let refreshed = try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: "account:profile-refresh",
                    kind: "account-profile",
                    priority: .p1,
                    intentRank: 20,
                    executionClass: .synchronization,
                    policy: .visible,
                    scope: profileScope(ownerScope: ownerScope, surface: "account-profile"),
                    dedupeKey: "account:profile-refresh:\(ownerScope)"
                )
            ) { [apiClient] context in
                try context.checkCancellation()
                var next = previous
                if shouldRefreshMetadata {
                    let response = try await apiClient.getJSON(
                        AccountRefreshUserResponse.self,
                        path: "/api/system/refresh-user",
                        authorization: .required,
                        retryOnConnectionLoss: true
                    )
                    guard response.success else {
                        throw AuthCenterError.invalidCredentials(
                            response.message ?? "无法刷新账户资料。"
                        )
                    }
                    if let user = response.user {
                        next = AccountProfileSnapshot(
                            identity: user.stableID,
                            userID: user.id,
                            username: user.username?.nonEmpty ?? next.username,
                            email: user.email,
                            phone: user.phone,
                            role: user.role,
                            bio: user.bio,
                            avatarData: next.avatarData,
                            avatarResolved: next.avatarResolved,
                            cachedAt: Date()
                        )
                    }
                }
                if shouldRefreshAvatar, let userID = next.userID {
                    let original = try await apiClient.requestData(
                        method: .get,
                        path: "/api/system/pfp/\(userID)",
                        authorization: .required,
                        retryOnConnectionLoss: true
                    )
                    next.avatarData = Self.displayAvatarData(from: original)
                    next.avatarResolved = true
                } else if shouldRefreshAvatar {
                    next.avatarData = nil
                    next.avatarResolved = true
                }
                next.cachedAt = Date()
                return next
            }

            profile = refreshed
            _ = try await serverStateCache.set(
                refreshed,
                key: cacheKey(identity: refreshed.identity),
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .accountProfile,
                scope: profileScope(ownerScope: ownerScope, surface: "account-profile")
            )
            status = .ready
        } catch is CancellationError {
            status = profile == nil ? .idle : .ready
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    private func cacheKey(identity: String) -> String {
        "account.profile:\(identity)"
    }

    private func profileScope(ownerScope: String, surface: String) -> AthenaTaskScope {
        AthenaTaskScope(
            owner: ownerScope,
            route: "account-profile",
            surface: surface,
            transport: "http"
        )
    }

    private static func multipartBody(
        data: Data,
        fieldName: String,
        filename: String,
        mimeType: String,
        boundary: String
    ) -> Data {
        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append(
            "Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(filename)\"\r\n"
        )
        body.append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n")
        return body
    }

    nonisolated private static func displayAvatarData(from data: Data) -> Data? {
        guard !data.isEmpty,
              let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return nil
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 512,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            options as CFDictionary
        ) else {
            return nil
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            output,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ) else {
            return nil
        }
        CGImageDestinationAddImage(
            destination,
            image,
            [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary
        )
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}

extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}
