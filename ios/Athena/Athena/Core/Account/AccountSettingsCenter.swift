import Foundation
import Observation
import SwiftUI

enum AthenaAppearance: String, Codable, CaseIterable, Identifiable, Sendable {
    case system
    case light
    case dark

    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum AthenaAppAccent: String, Codable, CaseIterable, Identifiable, Sendable {
    case blue
    case green
    case orange
    case pink
    case purple

    var id: String { rawValue }
    var title: String {
        switch self {
        case .blue: "蓝色"
        case .green: "绿色"
        case .orange: "橙色"
        case .pink: "粉色"
        case .purple: "紫色"
        }
    }
    var color: Color {
        switch self {
        case .blue: .blue
        case .green: .green
        case .orange: .orange
        case .pink: .pink
        case .purple: .purple
        }
    }
}

struct AccountSettingsPreferences: Codable, Equatable, Sendable {
    var appearance: AthenaAppearance = .system
    var accent: AthenaAppAccent = .blue
}

enum AccountRoleBadge: Equatable, Sendable {
    case administrator
    case owner

    static func resolve(_ role: String?) -> AccountRoleBadge? {
        switch role?.lowercased() {
        case "admin": .administrator
        case "owner": .owner
        default: nil
        }
    }

    var title: String {
        switch self {
        case .administrator: "管理员"
        case .owner: "所有者"
        }
    }

    var systemImage: String {
        switch self {
        case .administrator: "shield.lefthalf.filled"
        case .owner: "crown.fill"
        }
    }
}

struct PersonalizationProfile: Codable, Equatable, Sendable {
    var nickname = ""
    var modelIdentity = ""
    var responseStyle = ""
    var details = ""

    var serialized: String {
        """
        <personalization_profile>
        你的昵称: \(nickname.trimmingCharacters(in: .whitespacesAndNewlines))
        模型的身份: \(modelIdentity.trimmingCharacters(in: .whitespacesAndNewlines))
        风格: \(responseStyle.trimmingCharacters(in: .whitespacesAndNewlines))
        你的详情: \(details.trimmingCharacters(in: .whitespacesAndNewlines))
        </personalization_profile>
        """
    }

    static func parse(_ bio: String?) -> PersonalizationProfile {
        let rawText = (bio ?? "")
            .replacingOccurrences(of: "你的身份:", with: "模型的身份:")
        let openTag = "<personalization_profile>"
        let closeTag = "</personalization_profile>"
        guard let openRange = rawText.range(of: openTag),
              let closeRange = rawText.range(
                  of: closeTag,
                  range: openRange.upperBound..<rawText.endIndex
              ) else {
            return PersonalizationProfile(details: rawText.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        let content = String(rawText[openRange.upperBound..<closeRange.lowerBound])
        let labels = ["你的昵称", "模型的身份", "风格", "你的详情"]
        func value(for label: String) -> String {
            guard let labelRange = content.range(of: "\(label):") else { return "" }
            let valueStart = labelRange.upperBound
            let nextBoundary = labels
                .filter { $0 != label }
                .compactMap { nextLabel -> String.Index? in
                    content.range(
                        of: "\n\(nextLabel):",
                        range: valueStart..<content.endIndex
                    )?.lowerBound
                }
                .min() ?? content.endIndex
            return String(content[valueStart..<nextBoundary])
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return PersonalizationProfile(
            nickname: value(for: "你的昵称"),
            modelIdentity: value(for: "模型的身份"),
            responseStyle: value(for: "风格"),
            details: value(for: "你的详情")
        )
    }
}

typealias PersonalizationDraft = PersonalizationProfile

enum NativeMemoryCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case preferences
    case projects
    case facts
    case decisions
    case openTopics = "open_topics"
    case interests

    var id: String { rawValue }

    var title: String {
        switch self {
        case .preferences: "用户偏好"
        case .projects: "长期项目"
        case .facts: "长期事实"
        case .decisions: "重要决策"
        case .openTopics: "待解决问题"
        case .interests: "兴趣与研究方向"
        }
    }
}

struct NativeMemoryOverview: Codable, Equatable, Sendable {
    let overview: String
    let version: Int?
    let generatedAt: String?
}

struct NativeMemoryItem: Codable, Equatable, Identifiable, Sendable {
    let id: Int
    let category: String
    var title: String
    var detail: String
    let source: String?
    let confidence: String?
    let updatedAt: String?
    let isSensitive: Bool?
}

struct NativeMemoryBlock: Codable, Equatable, Identifiable, Sendable {
    let key: String
    let category: String
    let title: String
    let description: String?
    let count: Int
    var items: [NativeMemoryItem]
    var id: String { key }
}

struct NativeMemoryArchive: Codable, Equatable, Identifiable, Sendable {
    let id: Int
    let category: String
    let oldValue: String
    let replacedBy: Int?
    let archivedAt: String?

    var archivedMemory: NativeMemoryItem? {
        guard let data = oldValue.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(NativeMemoryItem.self, from: data)
    }
}

struct NativeMemoryCacheSnapshot: Codable, Equatable, Sendable {
    let overview: NativeMemoryOverview?
    let blocks: [NativeMemoryBlock]
}

struct NativeEmailStatus: Decodable, Equatable, Sendable {
    let success: Bool
    let email: String?
    let verified: Bool?
    let verifiedAt: String?
    let pendingEmail: String?
    let pendingChallengeId: String?
}

struct NativeLoginMethodRisk: Decodable, Equatable, Sendable {
    struct Methods: Decodable, Equatable, Sendable {
        let password: Bool
        let verifiedEmail: Bool
        let recoveryCodes: Bool
        let passkeys: Int
    }

    let methods: Methods
    let methodCount: Int
    let requiresConfirmation: Bool?
    let message: String?
}

struct NativePasskey: Decodable, Equatable, Identifiable, Sendable {
    let id: Int
    let deviceName: String?
    let deviceType: String?
    let browserName: String?
    let platformName: String?
    let providerName: String?
    let backedUp: Bool?
    let createdAt: String?
    let lastUsedAt: String?
}

enum ProviderSettingScalar: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case boolean(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .boolean(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else {
            self = .string(try container.decode(String.self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .boolean(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String {
        switch self {
        case .string(let value): value
        case .number(let value):
            value.rounded() == value ? String(Int(value)) : String(value)
        case .boolean(let value): value ? "true" : "false"
        case .null: ""
        }
    }
}

struct NativeProviderOption: Codable, Equatable, Identifiable, Sendable {
    let value: String
    let label: String
    var id: String { value }
}

struct NativeProviderField: Codable, Equatable, Identifiable, Sendable {
    let key: String
    let label: String
    let type: String
    let required: Bool
    let secret: Bool
    let options: [NativeProviderOption]
    var id: String { key }
}

struct NativeProviderDescriptor: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let supportsDynamicModels: Bool
    let fields: [NativeProviderField]
}

struct NativeProviderFieldValue: Codable, Equatable, Sendable {
    let configured: Bool
    let value: ProviderSettingScalar?
}

struct NativeProviderConfiguration: Codable, Equatable, Sendable {
    let provider: String
    let model: String?
    let values: [String: NativeProviderFieldValue]
}

struct NativeProviderSettingsSnapshot: Codable, Equatable, Sendable {
    let success: Bool
    let canManage: Bool
    let catalog: [NativeProviderDescriptor]
    let configuration: NativeProviderConfiguration
    let version: String?
    let error: String?
}

struct NativeProviderFieldMutation: Encodable, Equatable, Sendable {
    let action: String
    let value: ProviderSettingScalar?
}

private struct NativeProviderSettingsUpdateBody: Encodable {
    let provider: String
    let fields: [String: NativeProviderFieldMutation]
    let sourceActionId: String
}

struct NativeProviderModel: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, model
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedName = try container.decodeIfPresent(String.self, forKey: .name)
        let decodedModel = try container.decodeIfPresent(String.self, forKey: .model)
        if let value = try container.decodeIfPresent(String.self, forKey: .id) {
            id = value
        } else if let value = try? container.decode(Int.self, forKey: .id) {
            id = String(value)
        } else {
            id = decodedName ?? decodedModel ?? ""
        }
        name = decodedName ?? decodedModel
    }
}

private struct NativeProviderModelsResponse: Decodable {
    let models: [NativeProviderModel]
    let error: String?
}

private struct NativeProviderModelsRequest: Encodable {
    let provider: String
    let apiKey: String?
    let basePath: String?
}

struct NativeClientDevice: Decodable, Equatable, Identifiable, Sendable {
    let clientId: String
    let platform: String?
    let deviceName: String?
    let appVersion: String?
    let trustLevel: String?
    let createdAt: String?
    let lastSeenAt: String?
    let revokedAt: String?
    let isCurrentClient: Bool
    var id: String { clientId }
}

struct NativeAuthSession: Decodable, Equatable, Identifiable, Sendable {
    let sessionId: String
    let clientId: String?
    let authMode: String
    let tokenVersion: Int
    let createdAt: String?
    let lastSeenAt: String?
    let idleExpiresAt: String?
    let absoluteExpiresAt: String?
    let revokedAt: String?
    let revokeReason: String?
    let current: Bool
    var id: String { sessionId }
}

struct NativeAccountDeletionTotals: Decodable, Equatable, Sendable {
    let workspaceCount: Int
    let threadCount: Int
    let chatCount: Int
    let documentCount: Int
    let memoryCount: Int
}

struct NativeAccountDeletionPreview: Decodable, Equatable, Sendable {
    let username: String
    let emailMasked: String?
    let role: String?
    let willDeleteSharedAuthUser: Bool
    let totals: NativeAccountDeletionTotals
    let warnings: [String]
}

struct SettingsSuccessResponse: Decodable, Sendable {
    let success: Bool
    let error: String?
}

private struct SettingsUserResponse: Decodable, Sendable {
    let success: Bool
    let user: AthenaUser?
    let message: String?
}

private struct MemoryOverviewResponse: Decodable, Sendable {
    let success: Bool
    let overview: NativeMemoryOverview?
}

private struct MemoryBlocksResponse: Decodable, Sendable {
    let success: Bool
    let blocks: [NativeMemoryBlock]
}

private struct MemoryArchivesResponse: Decodable, Sendable {
    let success: Bool
    let archives: [NativeMemoryArchive]
}

private struct MemoryMutationResponse: Decodable, Sendable {
    let success: Bool
    let memory: NativeMemoryItem?
    let archivedId: Int?
    let error: String?
}

struct NativeSensitiveSession: Decodable, Equatable, Sendable {
    let sessionId: String?
    let token: String
    let resourceType: String?
    let ownerScope: String?
    let trustLevel: String?
    let createdAt: String?
    let expiresAt: String?
    let ttlMs: Int?
    let status: String?
}

private struct SensitiveMemoryRevealResponse: Decodable, Sendable {
    let success: Bool
    let memory: NativeMemoryItem
    let sensitiveSession: NativeSensitiveSession?
}

private struct EmailActionResponse: Decodable, Sendable {
    let success: Bool
    let error: String?
    let pendingEmail: String?
    let challengeId: String?
    let resendCooldownSeconds: Int?
}

private struct PasskeyListResponse: Decodable, Sendable {
    let success: Bool
    let passkeys: [NativePasskey]
    let risk: NativeLoginMethodRisk?
}

private struct PasskeyDeleteResponse: Decodable, Sendable {
    let success: Bool
    let requiresRiskConfirmation: Bool?
    let error: String?
}

private struct ClientListResponse: Decodable, Sendable {
    let success: Bool
    let clients: [NativeClientDevice]
}

private struct AuthSessionListResponse: Decodable, Sendable {
    let success: Bool
    let currentSessionId: String?
    let sessions: [NativeAuthSession]
    let error: String?
}

private struct AuthSessionMutationResponse: Decodable, Sendable {
    let success: Bool
    let revoked: Int?
    let currentSessionRevoked: Bool?
    let error: String?
}

private struct AccountDeletePreviewResponse: Decodable, Sendable {
    let success: Bool
    let preview: NativeAccountDeletionPreview
}

private struct ReauthResponse: Decodable, Sendable {
    let success: Bool
    let reauthToken: String?
    let error: String?
}

private struct AccountDeleteResponse: Decodable, Sendable {
    let success: Bool
    let error: String?
}

struct PersonalizationUpdateBody: Encodable {
    let bio: String
}

struct PasswordUpdateBody: Encodable {
    let password: String
    let currentPassword: String
}

private struct EmailRequestBody: Encodable { let email: String }
private struct EmailConfirmBody: Encodable { let email: String; let code: String; let challengeId: String? }
private struct PasswordReauthBody: Encodable { let currentPassword: String }
private struct DeleteAccountBody: Encodable { let confirm: Bool; let reauthToken: String }
private struct ClientRevokeBody: Encodable { let clientId: String }
private struct AuthSessionRevokeBody: Encodable { let sessionId: String }
private struct PasskeyDeleteBody: Encodable { let confirmRisk: Bool }
struct MemoryMutationBody: Encodable, Equatable, Sendable {
    let category: String
    let title: String
    let detail: String
    let source: String
    let confidence: String
    let isSensitive: Bool?
}

private struct SensitiveMemoryRevealBody: Encodable {
    let currentPassword: String?
    let reauthToken: String?
}

@MainActor
@Observable
final class PersonalizationSettingsStore {
    var profile = PersonalizationProfile()

    func reset() {
        profile = PersonalizationProfile()
    }
}

@MainActor
@Observable
final class MemorySettingsStore {
    var overview: NativeMemoryOverview?
    var blocks: [NativeMemoryBlock] = []
    var archives: [NativeMemoryArchive] = []
    var revealedSensitiveMemory: NativeMemoryItem?

    func reset() {
        overview = nil
        blocks = []
        archives = []
        revealedSensitiveMemory = nil
    }
}

@MainActor
@Observable
final class SecuritySettingsStore {
    var emailStatus: NativeEmailStatus?
    var loginRisk: NativeLoginMethodRisk?
    var emailResendAvailableAt: Date?

    var emailResendSecondsRemaining: Int {
        guard let emailResendAvailableAt else { return 0 }
        return max(0, Int(ceil(emailResendAvailableAt.timeIntervalSinceNow)))
    }

    func reset() {
        emailStatus = nil
        loginRisk = nil
        emailResendAvailableAt = nil
    }
}

@MainActor
@Observable
final class DeviceSettingsStore {
    var devices: [NativeClientDevice] = []

    func reset() {
        devices = []
    }
}

@MainActor
@Observable
final class ProviderSettingsStore {
    var snapshot: NativeProviderSettingsSnapshot?
    var selectedProviderID = ""
    var fieldDrafts: [String: String] = [:]
    var secretActions: [String: String] = [:]
    var modelOptions: [NativeProviderModel] = []
    private(set) var draftRevision = 0
    private(set) var pendingActionID: String?
    private(set) var pendingRevision: Int?

    var canManage: Bool { snapshot?.canManage == true }
    var catalog: [NativeProviderDescriptor] { snapshot?.catalog ?? [] }
    var selectedProvider: NativeProviderDescriptor? {
        catalog.first(where: { $0.id == selectedProviderID })
    }
    var hasUnsavedChanges: Bool {
        guard let snapshot, let provider = selectedProvider else { return false }
        if selectedProviderID != snapshot.configuration.provider {
            return true
        }
        return provider.fields.contains { field in
            if field.secret {
                return (secretActions[field.key] ?? "keep") != "keep"
            }
            let savedValue = snapshot.configuration.values[field.key]?.value?.stringValue ?? ""
            return (fieldDrafts[field.key] ?? "") != savedValue
        }
    }
    var isCurrentDraftAwaitingReconciliation: Bool {
        pendingActionID != nil && pendingRevision == draftRevision
    }

    func apply(_ snapshot: NativeProviderSettingsSnapshot) {
        self.snapshot = snapshot
        selectedProviderID = snapshot.configuration.provider
        populateDrafts()
    }

    func selectProvider(_ providerID: String) {
        guard providerID != selectedProviderID else { return }
        selectedProviderID = providerID
        populateDrafts()
        modelOptions = []
        draftRevision += 1
    }

    func updateField(_ key: String, value: String) {
        guard fieldDrafts[key] != value else { return }
        fieldDrafts[key] = value
        draftRevision += 1
    }

    func updateSecretAction(_ key: String, action: String) {
        guard secretActions[key] != action else { return }
        secretActions[key] = action
        draftRevision += 1
    }

    func applySaved(
        _ snapshot: NativeProviderSettingsSnapshot,
        expectedRevision: Int
    ) {
        guard draftRevision != expectedRevision else {
            apply(snapshot)
            return
        }
        self.snapshot = snapshot
    }

    func beginOptimisticSave(actionID: String, revision: Int) {
        pendingActionID = actionID
        pendingRevision = revision
    }

    func confirmOptimisticSave(
        actionID: String,
        snapshot: NativeProviderSettingsSnapshot,
        expectedRevision: Int
    ) {
        applySaved(snapshot, expectedRevision: expectedRevision)
        if pendingActionID == actionID {
            pendingActionID = nil
            pendingRevision = nil
        }
    }

    func rollBackOptimisticSave(
        actionID: String,
        snapshot: NativeProviderSettingsSnapshot?,
        expectedRevision: Int
    ) {
        if let snapshot {
            applySaved(snapshot, expectedRevision: expectedRevision)
        }
        if pendingActionID == actionID {
            pendingActionID = nil
            pendingRevision = nil
        }
    }

    func applySynced(
        _ snapshot: NativeProviderSettingsSnapshot,
        actionID: String?
    ) {
        let confirmsPendingAction = actionID != nil && actionID == pendingActionID
        let hasNewerDraft = pendingRevision.map { draftRevision > $0 } == true
        if hasUnsavedChanges && (!confirmsPendingAction || hasNewerDraft) {
            self.snapshot = snapshot
        } else {
            apply(snapshot)
        }
        if confirmsPendingAction {
            pendingActionID = nil
            pendingRevision = nil
        }
    }

    func reset() {
        snapshot = nil
        selectedProviderID = ""
        fieldDrafts = [:]
        secretActions = [:]
        modelOptions = []
        draftRevision = 0
        pendingActionID = nil
        pendingRevision = nil
    }

    private func populateDrafts() {
        guard let provider = selectedProvider else {
            fieldDrafts = [:]
            secretActions = [:]
            return
        }
        var drafts: [String: String] = [:]
        var actions: [String: String] = [:]
        for field in provider.fields {
            let value = snapshot?.configuration.values[field.key]
            if field.secret {
                drafts[field.key] = ""
                actions[field.key] = "keep"
            } else {
                drafts[field.key] = value?.value?.stringValue ?? ""
            }
        }
        fieldDrafts = drafts
        secretActions = actions
    }
}

@MainActor
@Observable
final class AccountSettingsCenter {
    enum Surface: String, Hashable, Sendable {
        case personalization, memory, sensitiveMemory, quickLogin
        case email, password, passkeys, sessions, devices, privacy, provider
    }

    private let apiClient: APIClient
    private let taskScheduler: TaskScheduler
    private let optimisticActionCenter: NativeOptimisticActionCenter
    private let recoveryCenter: NativeRecoveryCenter
    private let localCache: LocalCache
    private let serverStateCache: ServerStateCache
    private let profileCenter: AccountProfileCenter
    private let sensitiveSessionClient: SensitiveSessionClient
    private let passkeyAuthenticationClient: PasskeyAuthenticationClient
    private var ownerScope: String?

    let personalizationStore = PersonalizationSettingsStore()
    let memoryStore = MemorySettingsStore()
    let securityStore = SecuritySettingsStore()
    let deviceStore = DeviceSettingsStore()
    let providerStore = ProviderSettingsStore()
    private(set) var preferences = AccountSettingsPreferences()
    private(set) var personalization: PersonalizationDraft {
        get { personalizationStore.profile }
        set { personalizationStore.profile = newValue }
    }
    private(set) var memoryOverview: NativeMemoryOverview? {
        get { memoryStore.overview }
        set { memoryStore.overview = newValue }
    }
    private(set) var memoryBlocks: [NativeMemoryBlock] {
        get { memoryStore.blocks }
        set { memoryStore.blocks = newValue }
    }
    private(set) var memoryArchives: [NativeMemoryArchive] {
        get { memoryStore.archives }
        set { memoryStore.archives = newValue }
    }
    private(set) var revealedSensitiveMemory: NativeMemoryItem? {
        get { memoryStore.revealedSensitiveMemory }
        set { memoryStore.revealedSensitiveMemory = newValue }
    }
    private(set) var emailStatus: NativeEmailStatus? {
        get { securityStore.emailStatus }
        set { securityStore.emailStatus = newValue }
    }
    private(set) var passkeys: [NativePasskey] = []
    private(set) var authSessions: [NativeAuthSession] = []
    private(set) var clientDevices: [NativeClientDevice] {
        get { deviceStore.devices }
        set { deviceStore.devices = newValue }
    }
    private(set) var deletionPreview: NativeAccountDeletionPreview?
    private(set) var loadingSurfaces: Set<Surface> = []
    private(set) var savingSurfaces: Set<Surface> = []

    init(
        apiClient: APIClient,
        taskScheduler: TaskScheduler,
        optimisticActionCenter: NativeOptimisticActionCenter,
        recoveryCenter: NativeRecoveryCenter,
        localCache: LocalCache,
        serverStateCache: ServerStateCache,
        profileCenter: AccountProfileCenter,
        sensitiveSessionClient: SensitiveSessionClient,
        passkeyAuthenticationClient: PasskeyAuthenticationClient
    ) {
        self.apiClient = apiClient
        self.taskScheduler = taskScheduler
        self.optimisticActionCenter = optimisticActionCenter
        self.recoveryCenter = recoveryCenter
        self.localCache = localCache
        self.serverStateCache = serverStateCache
        self.profileCenter = profileCenter
        self.sensitiveSessionClient = sensitiveSessionClient
        self.passkeyAuthenticationClient = passkeyAuthenticationClient
    }

    var role: String? { profileCenter.role?.lowercased() }
    func isLoading(_ surface: Surface) -> Bool { loadingSurfaces.contains(surface) }
    func isSaving(_ surface: Surface) -> Bool { savingSurfaces.contains(surface) }

    func start(ownerScope: String) {
        self.ownerScope = ownerScope
        preferences = localCache.loadAccountSettingsPreferences(
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        ) ?? AccountSettingsPreferences()
        personalization = .parse(profileCenter.bio)
    }

    #if DEBUG
    func seedPreview() {
        emailStatus = NativeEmailStatus(
            success: true,
            email: "owner@athena.test",
            verified: true,
            verifiedAt: "2026-07-17T00:00:00.000Z",
            pendingEmail: nil,
            pendingChallengeId: nil
        )
        securityStore.loginRisk = NativeLoginMethodRisk(
            methods: .init(
                password: true,
                verifiedEmail: true,
                recoveryCodes: true,
                passkeys: 2
            ),
            methodCount: 5,
            requiresConfirmation: false,
            message: nil
        )
        passkeys = [
            NativePasskey(
                id: 1,
                deviceName: "iPhone 17 Pro",
                deviceType: "iphone",
                browserName: "Safari",
                platformName: "iOS",
                providerName: "Apple Passwords",
                backedUp: true,
                createdAt: "2026-07-15T00:00:00.000Z",
                lastUsedAt: "2026-07-17T00:00:00.000Z"
            ),
        ]
        authSessions = [
            NativeAuthSession(
                sessionId: "sess_preview",
                clientId: "preview-ios",
                authMode: "passkey",
                tokenVersion: 1,
                createdAt: "2026-07-15T00:00:00.000Z",
                lastSeenAt: "2026-07-17T00:00:00.000Z",
                idleExpiresAt: "2026-07-19T00:00:00.000Z",
                absoluteExpiresAt: "2026-08-15T00:00:00.000Z",
                revokedAt: nil,
                revokeReason: nil,
                current: true
            ),
        ]
        clientDevices = [
            NativeClientDevice(
                clientId: "preview-ios",
                platform: "ios",
                deviceName: "iPhone 17 Pro",
                appVersion: "2.2.8",
                trustLevel: "high",
                createdAt: "2026-07-15T00:00:00.000Z",
                lastSeenAt: "2026-07-17T00:00:00.000Z",
                revokedAt: nil,
                isCurrentClient: true
            ),
        ]
        providerStore.apply(
            NativeProviderSettingsSnapshot(
                success: true,
                canManage: true,
                catalog: [
                    NativeProviderDescriptor(
                        id: "deepseek",
                        name: "DeepSeek",
                        supportsDynamicModels: true,
                        fields: [
                            NativeProviderField(
                                key: "DeepSeekApiKey",
                                label: "API Key",
                                type: "secret",
                                required: true,
                                secret: true,
                                options: []
                            ),
                            NativeProviderField(
                                key: "DeepSeekModelPref",
                                label: "模型",
                                type: "text",
                                required: false,
                                secret: false,
                                options: []
                            ),
                        ]
                    ),
                    NativeProviderDescriptor(
                        id: "openai",
                        name: "OpenAI",
                        supportsDynamicModels: true,
                        fields: []
                    ),
                ],
                configuration: NativeProviderConfiguration(
                    provider: "deepseek",
                    model: "deepseek-v4-pro",
                    values: [
                        "DeepSeekApiKey": NativeProviderFieldValue(
                            configured: true,
                            value: nil
                        ),
                        "DeepSeekModelPref": NativeProviderFieldValue(
                            configured: true,
                            value: .string("deepseek-v4-pro")
                        ),
                    ]
                ),
                version: "preview",
                error: nil
            )
        )
    }
    #endif

    func reset() {
        ownerScope = nil
        personalizationStore.reset()
        memoryStore.reset()
        securityStore.reset()
        deviceStore.reset()
        providerStore.reset()
        passkeys = []
        authSessions = []
        deletionPreview = nil
        loadingSurfaces = []
        savingSurfaces = []
        sensitiveSessionClient.end()
    }

    func setAppearance(_ appearance: AthenaAppearance) {
        preferences.appearance = appearance
        persistPreferences()
    }

    func setAccent(_ accent: AthenaAppAccent) {
        preferences.accent = accent
        persistPreferences()
    }

    func loadPersonalization(forceRefresh: Bool = false) async {
        if !forceRefresh {
            personalization = .parse(profileCenter.bio)
            return
        }
        await performRead(.personalization, label: "settings:personalization") { [apiClient] in
            let response = try await apiClient.getJSON(
                SettingsUserResponse.self,
                path: "/api/system/refresh-user",
                authorization: .required,
                signing: .none,
                retryOnConnectionLoss: true
            )
            guard response.success, let user = response.user else {
                throw SettingsCenterError.server(response.message ?? "无法读取个性化设置。")
            }
            return PersonalizationDraft.parse(user.bio)
        } apply: { [weak self] draft in
            self?.personalization = draft
        }
    }

    func savePersonalization(_ draft: PersonalizationDraft) async -> Bool {
        guard draft.serialized.count <= 1000 else {
            present(SettingsCenterError.server("个性化资料不能超过 1000 个字符。"), title: "无法保存")
            return false
        }
        return await performWrite(.personalization, label: "settings:personalization-save") { [apiClient] in
            let response = try await apiClient.requestJSON(
                SettingsSuccessResponse.self,
                method: .post,
                path: "/api/system/user",
                body: PersonalizationUpdateBody(bio: draft.serialized),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法保存。") }
            return true
        } apply: { [weak self] (_: Bool) in
            self?.personalization = draft
            await self?.profileCenter.applyConfirmedBio(draft.serialized)
        }
    }

    func loadMemory(forceRefresh: Bool = false) async {
        guard let ownerScope else {
            present(APIClientError.authenticationRequired, title: "无法载入")
            return
        }
        loadingSurfaces.insert(.memory)
        defer { loadingSurfaces.remove(.memory) }
        do {
            let snapshot = try await serverStateCache.load(
                NativeMemoryCacheSnapshot.self,
                key: memoryCacheKey,
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .longTermMemory,
                forceRefresh: forceRefresh,
                task: AthenaTaskDescriptor(
                    label: "settings:memory",
                    kind: "account-settings-read",
                    priority: .p1,
                    intentRank: 20,
                    executionClass: .synchronization,
                    policy: .visible,
                    scope: memoryScope(ownerScope: ownerScope),
                    dedupeKey: "settings:memory:\(ownerScope)"
                )
            ) { [apiClient] in
                async let overview = apiClient.getJSON(
                    MemoryOverviewResponse.self,
                    path: "/api/system/user/memory/overview",
                    authorization: .required,
                    signing: .none,
                    retryOnConnectionLoss: true
                )
                async let blocks = apiClient.getJSON(
                    MemoryBlocksResponse.self,
                    path: "/api/system/user/memory/blocks",
                    queryItems: [URLQueryItem(name: "detail", value: "full")],
                    authorization: .required,
                    signing: .none,
                    retryOnConnectionLoss: true
                )
                let values = try await (overview, blocks)
                return NativeMemoryCacheSnapshot(
                    overview: values.0.overview,
                    blocks: values.1.blocks
                )
            }
            memoryOverview = snapshot.overview
            memoryBlocks = snapshot.blocks
        } catch {
            present(error, title: "无法载入")
        }
    }

    func rebuildMemory() async -> Bool {
        await performWrite(.memory, label: "settings:memory-rebuild") { [apiClient] in
            let response = try await apiClient.requestJSON(
                SettingsSuccessResponse.self,
                method: .post,
                path: "/api/system/user/memory/rebuild",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法重建长期记忆。") }
            return true
        } apply: { [weak self] _ in await self?.refreshMemoryAfterMutation() }
    }

    func createMemory(_ body: MemoryMutationBody) async -> Bool {
        await performWrite(.memory, label: "settings:memory-create") { [apiClient] in
            let response = try await apiClient.requestJSON(
                MemoryMutationResponse.self,
                method: .post,
                path: "/api/system/user/memory/candidates",
                body: body,
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else {
                throw SettingsCenterError.server(response.error ?? "无法添加记忆。")
            }
            if body.isSensitive != true {
                let rebuild = try await apiClient.requestJSON(
                    SettingsSuccessResponse.self,
                    method: .post,
                    path: "/api/system/user/memory/rebuild",
                    authorization: .required,
                    signing: .required,
                    retryOnConnectionLoss: true
                )
                guard rebuild.success else {
                    throw SettingsCenterError.server(
                        rebuild.error ?? "记忆已提交，但暂时无法更新长期画像。"
                    )
                }
            }
            return true
        } apply: { [weak self] _ in await self?.refreshMemoryAfterMutation() }
    }

    func updateMemory(_ item: NativeMemoryItem, body: MemoryMutationBody) async -> Bool {
        await performWrite(.memory, label: "settings:memory-update") { [apiClient] in
            let response = try await apiClient.requestJSON(
                MemoryMutationResponse.self,
                method: .patch,
                path: "/api/system/user/memory/\(item.id)",
                body: body,
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法更新记忆。") }
            return true
        } apply: { [weak self] _ in await self?.refreshMemoryAfterMutation() }
    }

    func deleteMemory(_ item: NativeMemoryItem) async -> Bool {
        await performWrite(.memory, label: "settings:memory-delete") { [apiClient] in
            let response = try await apiClient.requestJSON(
                MemoryMutationResponse.self,
                method: .delete,
                path: "/api/system/user/memory/\(item.id)",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法归档记忆。") }
            return true
        } apply: { [weak self] _ in
            await self?.refreshMemoryAfterMutation()
            await self?.loadMemoryArchives()
        }
    }

    func loadMemoryArchives() async {
        await performRead(.memory, label: "settings:memory-archives") { [apiClient] in
            let response = try await apiClient.getJSON(
                MemoryArchivesResponse.self,
                path: "/api/system/user/memory/archives",
                queryItems: [
                    URLQueryItem(name: "limit", value: "100"),
                    URLQueryItem(name: "offset", value: "0"),
                ],
                authorization: .required,
                signing: .none,
                retryOnConnectionLoss: true
            )
            return response.archives
        } apply: { [weak self] in self?.memoryArchives = $0 }
    }

    func revealSensitiveMemory(
        _ item: NativeMemoryItem,
        currentPassword: String? = nil,
        reauthToken: String? = nil
    ) async -> Bool {
        let sessionHeaders = sensitiveSessionClient.headers(for: String(item.id))
        return await performWrite(
            .sensitiveMemory,
            label: "settings:memory-sensitive-reveal"
        ) { [apiClient] in
            let response = try await apiClient.requestJSON(
                SensitiveMemoryRevealResponse.self,
                method: .post,
                path: "/api/system/user/memory/\(item.id)/reveal",
                headers: sessionHeaders,
                body: SensitiveMemoryRevealBody(
                    currentPassword: currentPassword?.nonEmpty,
                    reauthToken: reauthToken?.nonEmpty
                ),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: false
            )
            guard response.success else {
                throw SettingsCenterError.server("无法查看敏感记忆。")
            }
            return response
        } apply: { [weak self] response in
            self?.revealedSensitiveMemory = response.memory
            if let session = response.sensitiveSession {
                self?.sensitiveSessionClient.activate(
                    session,
                    resourceID: String(item.id)
                )
            }
        }
    }

    func revealSensitiveMemoryUsingPasskey(_ item: NativeMemoryItem) async -> Bool {
        do {
            let handoff = try await passkeyAuthenticationClient.performNativeHandoff(
                purpose: .sensitiveMemoryReveal,
                using: apiClient
            )
            guard let token = handoff.reauthToken?.nonEmpty else {
                throw SettingsCenterError.server("通行密钥未返回敏感记忆授权。")
            }
            return await revealSensitiveMemory(item, reauthToken: token)
        } catch PasskeyAuthenticationError.cancelled {
            return false
        } catch {
            recoveryCenter.present(
                recoveryCenter.classify(error),
                title: "无法查看敏感记忆"
            )
            return false
        }
    }

    func clearSensitiveMemory() {
        revealedSensitiveMemory = nil
        sensitiveSessionClient.end()
    }

    func refreshMemoryFromUnifiedSync() async {
        guard let ownerScope else { return }
        await serverStateCache.markStale(
            key: memoryCacheKey,
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
        await loadMemory(forceRefresh: true)
    }

    func loadEmailStatus() async {
        await performRead(.email, label: "settings:email") { [apiClient] in
            try await apiClient.getJSON(
                NativeEmailStatus.self,
                path: "/api/system/user/email-verification",
                authorization: .required,
                signing: .none,
                retryOnConnectionLoss: true
            )
        } apply: { [weak self] in self?.emailStatus = $0 }
    }

    func requestEmailCode(_ email: String) async -> String? {
        var challenge: String?
        var cooldown = 60
        let success = await performWrite(.email, label: "settings:email-request") { [apiClient] in
            let response = try await apiClient.requestJSON(
                EmailActionResponse.self,
                method: .post,
                path: "/api/system/user/email-verification/request",
                body: EmailRequestBody(email: email),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法发送验证码。") }
            return (response.challengeId, response.resendCooldownSeconds ?? 60)
        } apply: { [weak self] value in
            challenge = value.0
            cooldown = value.1
            self?.securityStore.emailResendAvailableAt = Date()
                .addingTimeInterval(TimeInterval(cooldown))
        }
        return success ? challenge : nil
    }

    func confirmEmail(_ email: String, code: String, challengeID: String?) async -> Bool {
        await performWrite(.email, label: "settings:email-confirm") { [apiClient] in
            let response = try await apiClient.requestJSON(
                EmailActionResponse.self,
                method: .post,
                path: "/api/system/user/email-verification/confirm",
                body: EmailConfirmBody(email: email, code: code, challengeId: challengeID),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "验证码无效。") }
            return true
        } apply: { [weak self] _ in
            await self?.profileCenter.refreshForFullReconciliation()
            await self?.loadEmailStatus()
        }
    }

    func changePassword(current: String, new: String) async -> Bool {
        await performWrite(.password, label: "settings:password") { [apiClient] in
            let response = try await apiClient.requestJSON(
                SettingsSuccessResponse.self,
                method: .post,
                path: "/api/system/user",
                body: PasswordUpdateBody(
                    password: new,
                    currentPassword: current
                ),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法修改密码。") }
            return true
        } apply: { _ in }
    }

    func loadPasskeys() async {
        await performRead(.passkeys, label: "settings:passkeys") { [apiClient] in
            let response = try await apiClient.getJSON(
                PasskeyListResponse.self,
                path: "/api/auth/passkeys",
                authorization: .required,
                signing: .none,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server("无法读取通行密钥。") }
            return response
        } apply: { [weak self] response in
            self?.passkeys = response.passkeys
            self?.securityStore.loginRisk = response.risk
        }
    }

    func registerPasskey() async -> Bool {
        await performWrite(.passkeys, label: "settings:passkey-register") {
            [passkeyAuthenticationClient, apiClient] in
            try await passkeyAuthenticationClient.registerPasskey(using: apiClient)
            return true
        } apply: { [weak self] _ in
            await self?.loadPasskeys()
        }
    }

    func deletePasskey(_ passkey: NativePasskey, confirmRisk: Bool = false) async -> Bool {
        await performWrite(.passkeys, label: "settings:passkey-delete") { [apiClient] in
            let response = try await apiClient.requestJSON(
                PasskeyDeleteResponse.self,
                method: .delete,
                path: "/api/auth/passkeys/\(passkey.id)",
                body: PasskeyDeleteBody(confirmRisk: confirmRisk),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            if response.requiresRiskConfirmation == true {
                throw SettingsCenterError.requiresConfirmation
            }
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法删除通行密钥。") }
            return true
        } apply: { [weak self] _ in await self?.loadPasskeys() }
    }

    func loadClientDevices() async {
        await performRead(.devices, label: "settings:devices") { [apiClient] in
            let response = try await apiClient.getJSON(
                ClientListResponse.self,
                path: "/api/client-identity/clients",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            return response.clients
        } apply: { [weak self] in self?.clientDevices = $0 }
    }

    func loadAuthSessions() async {
        await performRead(.sessions, label: "settings:sessions") { [apiClient] in
            let response = try await apiClient.getJSON(
                AuthSessionListResponse.self,
                path: "/api/system/sessions",
                authorization: .required,
                signing: .none,
                retryOnConnectionLoss: true
            )
            guard response.success else {
                throw SettingsCenterError.server(response.error ?? "无法读取登录会话。")
            }
            return response.sessions
        } apply: { [weak self] in self?.authSessions = $0 }
    }

    func revokeAuthSession(_ session: NativeAuthSession) async -> Bool {
        await performWrite(.sessions, label: "settings:session-revoke") { [apiClient] in
            let response = try await apiClient.requestJSON(
                AuthSessionMutationResponse.self,
                method: .post,
                path: "/api/system/sessions/revoke",
                body: AuthSessionRevokeBody(sessionId: session.sessionId),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else {
                throw SettingsCenterError.server(response.error ?? "无法退出登录会话。")
            }
            return true
        } apply: { [weak self] _ in
            if !session.current { await self?.loadAuthSessions() }
        }
    }

    func revokeOtherAuthSessions() async -> Bool {
        await performWrite(.sessions, label: "settings:sessions-revoke-others") { [apiClient] in
            let response = try await apiClient.requestJSON(
                AuthSessionMutationResponse.self,
                method: .post,
                path: "/api/system/sessions/revoke-others",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else {
                throw SettingsCenterError.server(response.error ?? "无法退出其他登录会话。")
            }
            return true
        } apply: { [weak self] _ in await self?.loadAuthSessions() }
    }

    func revokeAllAuthSessions() async -> Bool {
        await performWrite(.sessions, label: "settings:sessions-revoke-all") { [apiClient] in
            let response = try await apiClient.requestJSON(
                AuthSessionMutationResponse.self,
                method: .post,
                path: "/api/system/sessions/revoke-all",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else {
                throw SettingsCenterError.server(response.error ?? "无法退出全部登录会话。")
            }
            return true
        } apply: { _ in }
    }

    func revokeClient(_ device: NativeClientDevice) async -> Bool {
        await performWrite(.devices, label: "settings:device-revoke") { [apiClient] in
            let response = try await apiClient.requestJSON(
                SettingsSuccessResponse.self,
                method: .post,
                path: "/api/client-identity/revoke",
                body: ClientRevokeBody(clientId: device.clientId),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法撤销设备。") }
            return true
        } apply: { [weak self] _ in await self?.loadClientDevices() }
    }

    func revokeOtherClients() async -> Bool {
        await performWrite(.devices, label: "settings:devices-revoke-others") { [apiClient] in
            let response = try await apiClient.requestJSON(
                SettingsSuccessResponse.self,
                method: .post,
                path: "/api/client-identity/revoke-all-others",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "无法撤销其他设备。") }
            return true
        } apply: { [weak self] _ in await self?.loadClientDevices() }
    }

    func loadProviderSettings(forceRefresh: Bool = false) async {
        guard let ownerScope else {
            present(APIClientError.authenticationRequired, title: "无法载入")
            return
        }
        loadingSurfaces.insert(.provider)
        defer { loadingSurfaces.remove(.provider) }
        do {
            let snapshot = try await serverStateCache.load(
                NativeProviderSettingsSnapshot.self,
                key: providerConfigurationCacheKey,
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .providerConfiguration,
                forceRefresh: forceRefresh,
                task: AthenaTaskDescriptor(
                    label: "settings:provider",
                    kind: "account-settings-read",
                    priority: .p1,
                    intentRank: 20,
                    executionClass: .synchronization,
                    policy: .visible,
                    scope: providerScope(ownerScope: ownerScope),
                    dedupeKey: "settings:provider:\(ownerScope)"
                )
            ) { [apiClient] in
                try await apiClient.getJSON(
                    NativeProviderSettingsSnapshot.self,
                    path: "/api/system/provider-settings/llm",
                    authorization: .required,
                    signing: .none,
                    retryOnConnectionLoss: true
                )
            }
            providerStore.applySynced(snapshot, actionID: nil)
            if !snapshot.catalog.isEmpty {
                _ = try? await serverStateCache.set(
                    snapshot.catalog,
                    key: providerCatalogCacheKey,
                    ownerScope: ownerScope,
                    apiBase: apiClient.configuration.normalizedBaseURL,
                    policy: .providerCatalog,
                    scope: providerScope(ownerScope: ownerScope)
                )
            }
        } catch {
            if let catalog = await serverStateCache.cachedValue(
                [NativeProviderDescriptor].self,
                key: providerCatalogCacheKey,
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                allowExpired: true
            ), let current = providerStore.snapshot {
                providerStore.applySynced(
                    NativeProviderSettingsSnapshot(
                        success: current.success,
                        canManage: current.canManage,
                        catalog: catalog,
                        configuration: current.configuration,
                        version: current.version,
                        error: current.error
                    ),
                    actionID: nil
                )
            }
            present(error, title: "无法载入")
        }
    }

    func saveProviderSettings() async -> Bool {
        guard providerStore.canManage,
              let provider = providerStore.selectedProvider,
              let ownerScope else {
            present(SettingsCenterError.server("当前账户没有修改提供商的权限。"), title: "无法保存")
            return false
        }
        let expectedRevision = providerStore.draftRevision
        let previousSnapshot = providerStore.snapshot
        let fieldDrafts = providerStore.fieldDrafts
        let secretActions = providerStore.secretActions
        let actionID = UUID().uuidString.lowercased()
        let scope = providerScope(ownerScope: ownerScope)
        var mutations: [String: NativeProviderFieldMutation] = [:]
        for field in provider.fields {
            if field.secret {
                let action = secretActions[field.key] ?? "keep"
                mutations[field.key] = NativeProviderFieldMutation(
                    action: action,
                    value: action == "replace"
                        ? .string(fieldDrafts[field.key] ?? "")
                        : nil
                )
            } else {
                mutations[field.key] = NativeProviderFieldMutation(
                    action: "set",
                    value: .string(fieldDrafts[field.key] ?? "")
                )
            }
        }
        let providerMutations = mutations

        providerStore.beginOptimisticSave(
            actionID: actionID,
            revision: expectedRevision
        )
        optimisticActionCenter.begin(
            id: actionID,
            type: .updateProviderSettings,
            scope: scope
        )
        savingSurfaces.insert(.provider)
        defer { savingSurfaces.remove(.provider) }

        do {
            let handle = try await taskScheduler.schedule(
                AthenaTaskDescriptor(
                    id: actionID,
                    label: "settings:provider-save",
                    kind: "provider-settings-write",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: scope,
                    dedupeKey: "settings:provider-save:\(actionID)",
                    isProtected: true,
                    isAbortable: false
                )
            ) { [apiClient] context in
                try context.checkCancellation()
                let response = try await apiClient.requestJSON(
                    NativeProviderSettingsSnapshot.self,
                    method: .post,
                    path: "/api/system/provider-settings/llm",
                    body: NativeProviderSettingsUpdateBody(
                        provider: provider.id,
                        fields: providerMutations,
                        sourceActionId: actionID
                    ),
                    authorization: .required,
                    signing: .required,
                    retryOnConnectionLoss: true
                )
                guard response.success else {
                    throw SettingsCenterError.server(
                        response.error ?? "无法保存人工智能提供商设置。"
                    )
                }
                return response
            }
            optimisticActionCenter.update(
                actionID,
                status: .confirming,
                taskID: handle.id
            )
            let response = try await handle.value
            providerStore.confirmOptimisticSave(
                actionID: actionID,
                snapshot: response,
                expectedRevision: expectedRevision
            )
            optimisticActionCenter.confirm(actionID)
            _ = try? await serverStateCache.set(
                response,
                key: providerConfigurationCacheKey,
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .providerConfiguration,
                scope: scope
            )
            return true
        } catch {
            let directive = recoveryCenter.classify(error)
            if directive.disposition == .reconcile {
                optimisticActionCenter.update(actionID, status: .reconciling)
            } else {
                providerStore.rollBackOptimisticSave(
                    actionID: actionID,
                    snapshot: previousSnapshot,
                    expectedRevision: expectedRevision
                )
                if directive.disposition == .silent {
                    optimisticActionCenter.fail(actionID)
                } else {
                    optimisticActionCenter.rollBack(actionID)
                }
            }
            recoveryCenter.present(
                directive,
                title: "无法更新人工智能提供商"
            )
            return false
        }
    }

    func loadProviderModels() async {
        guard providerStore.canManage,
              let provider = providerStore.selectedProvider,
              provider.supportsDynamicModels else {
            providerStore.modelOptions = []
            return
        }
        await performRead(.provider, label: "settings:provider-models:\(provider.id)") {
            [apiClient, providerStore] in
            let secretField = provider.fields.first(where: { $0.secret })
            let basePathField = provider.fields.first(where: {
                $0.key.localizedCaseInsensitiveContains("basePath")
                    || $0.key.localizedCaseInsensitiveContains("endpoint")
            })
            let apiKey = secretField.flatMap { field -> String? in
                guard providerStore.secretActions[field.key] == "replace" else { return nil }
                return providerStore.fieldDrafts[field.key]?.nonEmpty
            }
            let basePath = basePathField.flatMap {
                providerStore.fieldDrafts[$0.key]?.nonEmpty
            }
            return try await apiClient.requestJSON(
                NativeProviderModelsResponse.self,
                method: .post,
                path: "/api/system/custom-models",
                body: NativeProviderModelsRequest(
                    provider: provider.id,
                    apiKey: apiKey,
                    basePath: basePath
                ),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
        } apply: { [weak self] response in
            if let error = response.error?.nonEmpty {
                self?.present(SettingsCenterError.server(error), title: "无法读取模型")
            } else {
                self?.providerStore.modelOptions = response.models
            }
        }
    }

    func refreshProviderFromUnifiedSync(actionID: String? = nil) async {
        guard let ownerScope else { return }
        await serverStateCache.markStale(
            key: providerConfigurationCacheKey,
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
        loadingSurfaces.insert(.provider)
        defer { loadingSurfaces.remove(.provider) }
        do {
            let snapshot = try await apiClient.getJSON(
                NativeProviderSettingsSnapshot.self,
                path: "/api/system/provider-settings/llm",
                authorization: .required,
                signing: .none,
                retryOnConnectionLoss: true
            )
            providerStore.applySynced(snapshot, actionID: actionID)
            _ = try? await serverStateCache.set(
                snapshot,
                key: providerConfigurationCacheKey,
                ownerScope: ownerScope,
                apiBase: apiClient.configuration.normalizedBaseURL,
                policy: .providerConfiguration,
                scope: providerScope(ownerScope: ownerScope)
            )
        } catch {
            present(error, title: "无法同步人工智能提供商")
        }
    }

    func loadDeletionPreview() async {
        await performRead(.privacy, label: "settings:delete-preview") { [apiClient] in
            try await apiClient.getJSON(
                AccountDeletePreviewResponse.self,
                path: "/api/system/user/delete-preview",
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            ).preview
        } apply: { [weak self] in self?.deletionPreview = $0 }
    }

    func deleteAccount(currentPassword: String) async -> Bool {
        await performWrite(.privacy, label: "settings:account-delete") { [apiClient] in
            let reauth = try await apiClient.requestJSON(
                ReauthResponse.self,
                method: .post,
                path: "/api/system/user/delete/reauth/password",
                body: PasswordReauthBody(currentPassword: currentPassword),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard reauth.success, let token = reauth.reauthToken else {
                throw SettingsCenterError.server(reauth.error ?? "安全验证失败。")
            }
            let response = try await apiClient.requestJSON(
                AccountDeleteResponse.self,
                method: .delete,
                path: "/api/system/user",
                body: DeleteAccountBody(confirm: true, reauthToken: token),
                authorization: .required,
                signing: .required,
                retryOnConnectionLoss: true
            )
            guard response.success else { throw SettingsCenterError.server(response.error ?? "删除账户失败。") }
            return true
        } apply: { _ in }
    }

    private func persistPreferences() {
        guard let ownerScope else { return }
        try? localCache.saveAccountSettingsPreferences(
            preferences,
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
    }

    private var memoryCacheKey: String {
        "account.settings.memory"
    }

    private var providerCatalogCacheKey: String {
        "account.settings.provider.catalog"
    }

    private var providerConfigurationCacheKey: String {
        "account.settings.provider.configuration"
    }

    private func memoryScope(ownerScope: String) -> AthenaTaskScope {
        AthenaTaskScope(
            owner: ownerScope,
            route: "account-settings",
            surface: "long-term-memory",
            transport: "http"
        )
    }

    private func providerScope(ownerScope: String) -> AthenaTaskScope {
        AthenaTaskScope(
            owner: ownerScope,
            route: "account-settings",
            surface: "llm-provider",
            transport: "http"
        )
    }

    private func refreshMemoryAfterMutation() async {
        guard let ownerScope else { return }
        await serverStateCache.markStale(
            key: memoryCacheKey,
            ownerScope: ownerScope,
            apiBase: apiClient.configuration.normalizedBaseURL
        )
        await loadMemory(forceRefresh: true)
    }

    private func performRead<Value: Sendable>(
        _ surface: Surface,
        label: String,
        operation: @escaping @MainActor @Sendable () async throws -> Value,
        apply: @escaping @MainActor (Value) async -> Void
    ) async {
        loadingSurfaces.insert(surface)
        defer { loadingSurfaces.remove(surface) }
        do {
            guard ownerScope != nil else { throw APIClientError.authenticationRequired }
            let value = try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: label,
                    kind: "account-settings-read",
                    priority: .p1,
                    intentRank: 20,
                    executionClass: .synchronization,
                    policy: .visible,
                    scope: AthenaTaskScope(surface: label),
                    dedupeKey: label
                )
            ) { context in
                try context.checkCancellation()
                return try await operation()
            }
            await apply(value)
        } catch { present(error, title: "无法载入") }
    }

    @discardableResult
    private func performWrite<Value: Sendable>(
        _ surface: Surface,
        label: String,
        operation: @escaping @MainActor @Sendable () async throws -> Value,
        apply: @escaping @MainActor (Value) async -> Void
    ) async -> Bool {
        savingSurfaces.insert(surface)
        defer { savingSurfaces.remove(surface) }
        do {
            guard ownerScope != nil else { throw APIClientError.authenticationRequired }
            let value = try await taskScheduler.run(
                AthenaTaskDescriptor(
                    label: label,
                    kind: "account-settings-write",
                    priority: .p0,
                    intentRank: 0,
                    executionClass: .interactiveMutation,
                    policy: .foreground,
                    scope: AthenaTaskScope(surface: label),
                    dedupeKey: label,
                    isProtected: true,
                    isAbortable: false
                )
            ) { context in
                try context.checkCancellation()
                return try await operation()
            }
            await apply(value)
            return true
        } catch {
            if error as? PasskeyAuthenticationError == .cancelled {
                return false
            }
            present(error, title: "操作未完成")
            return false
        }
    }

    private func present(_ error: Error, title: String) {
        recoveryCenter.present(recoveryCenter.classify(error), title: title)
    }
}

enum SettingsCenterError: LocalizedError, Equatable {
    case server(String)
    case requiresConfirmation

    var errorDescription: String? {
        switch self {
        case .server(let message): message
        case .requiresConfirmation: "删除此通行密钥可能使账户失去可用登录方式。"
        }
    }
}
