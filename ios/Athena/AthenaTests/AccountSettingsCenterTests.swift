import Foundation
import Testing
@testable import Athena

struct AccountSettingsCenterTests {
    @Test
    func roleBadgeMappingOnlyShowsPrivilegedRoles() {
        #expect(AccountRoleBadge.resolve("admin") == .administrator)
        #expect(AccountRoleBadge.resolve("OWNER") == .owner)
        #expect(AccountRoleBadge.resolve("developer") == nil)
        #expect(AccountRoleBadge.resolve("user") == nil)
        #expect(AccountRoleBadge.resolve(nil) == nil)
    }

    @Test
    func quickLoginUsesTheLocalSessionUserIDForServerMapping() {
        let user = AthenaUser(
            id: 7,
            authUserId: 91,
            username: "shijie",
            role: "owner",
            email: nil,
            phone: nil,
            displayName: nil,
            pfpFilename: nil
        )

        #expect(user.quickLoginSubjectID == 7)
        #expect(user.authenticationID == 91)
    }

    @Test
    func legacyProfileCacheDecodesWithoutRoleOrBio() throws {
        let json = """
        {
          "identity": "42",
          "userID": 42,
          "username": "athena-user",
          "email": "user@example.com",
          "phone": null,
          "avatarData": null,
          "avatarResolved": true,
          "cachedAt": 0
        }
        """.data(using: .utf8)!
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        let snapshot = try decoder.decode(AccountProfileSnapshot.self, from: json)
        #expect(snapshot.role == nil)
        #expect(snapshot.bio == nil)
        #expect(snapshot.username == "athena-user")
    }

    @Test
    func personalizationUsesWebCompatibleBioFormat() {
        let draft = PersonalizationDraft(
            nickname: "Shijie",
            modelIdentity: "研究助手",
            responseStyle: "简洁",
            details: "优先给出结论"
        )
        let decoded = PersonalizationDraft.parse(draft.serialized)
        #expect(decoded == draft)
        #expect(draft.serialized.contains("<personalization_profile>"))
        #expect(draft.serialized.contains("模型的身份: 研究助手"))
    }

    @Test
    func personalizationPreservesMultilineDetailsAndLegacyIdentityLabel() {
        let bio = """
        <personalization_profile>
        你的昵称: 少爷
        你的身份: 研究搭档
        风格: 先结论后证据
        你的详情: 第一行
        第二行包含完整上下文。
        第三行继续保留。
        </personalization_profile>
        """
        let profile = PersonalizationProfile.parse(bio)

        #expect(profile.nickname == "少爷")
        #expect(profile.modelIdentity == "研究搭档")
        #expect(profile.responseStyle == "先结论后证据")
        #expect(profile.details == "第一行\n第二行包含完整上下文。\n第三行继续保留。")
        #expect(PersonalizationProfile.parse(profile.serialized) == profile)
    }

    @Test
    func personalizationUpdateBodyOnlyContainsBio() throws {
        let data = try JSONEncoder().encode(
            PersonalizationUpdateBody(bio: "<personalization_profile />")
        )
        let object = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: String]
        )
        #expect(Set(object.keys) == ["bio"])
    }

    @Test
    func memoryMutationBodyCarriesTheCompleteServerContract() throws {
        let body = MemoryMutationBody(
            category: NativeMemoryCategory.projects.rawValue,
            title: "Athena iOS",
            detail: "完善原生设置页",
            source: "用户手动添加",
            confidence: "高",
            isSensitive: true
        )
        let data = try JSONEncoder().encode(body)
        let object = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        #expect(Set(object.keys) == [
            "category", "title", "detail", "source", "confidence", "isSensitive",
        ])
        #expect(object["category"] as? String == "projects")
        #expect(object["confidence"] as? String == "高")
        #expect(object["isSensitive"] as? Bool == true)
    }

    @MainActor
    @Test
    func sensitiveSessionIsScopedAndClearedExplicitly() {
        let client = SensitiveSessionClient()
        client.activate(
            NativeSensitiveSession(
                sessionId: "session",
                token: "secret-token",
                resourceType: "user_memory",
                ownerScope: "user:1:memory",
                trustLevel: "reauthenticated",
                createdAt: nil,
                expiresAt: nil,
                ttlMs: 300_000,
                status: "active"
            ),
            resourceID: "42"
        )

        #expect(client.headers(for: "41").isEmpty)
        #expect(client.headers(for: "42") == [
            "X-Athena-Sensitive-Session": "secret-token",
        ])
        client.end()
        #expect(client.headers(for: "42").isEmpty)
        #expect(client.status == .inactive)
    }

    @Test
    func opaqueClientStartsRegistrationAndLoginWithoutExposingTheSecret() throws {
        let client = OpaqueClient()
        let secret = "device-secret-used-only-for-testing"
        let registration = try client.startRegistration(secret: secret)
        let login = try client.startLogin(secret: secret)

        #expect(!registration.clientRegistrationState.isEmpty)
        #expect(!registration.registrationRequest.isEmpty)
        #expect(!login.clientLoginState.isEmpty)
        #expect(!login.startLoginRequest.isEmpty)
        #expect(!registration.registrationRequest.contains(secret))
        #expect(!login.startLoginRequest.contains(secret))
    }

    @Test
    func passwordUpdateBodyCannotOverwriteProfileFields() throws {
        let data = try JSONEncoder().encode(
            PasswordUpdateBody(password: "new-password", currentPassword: "old-password")
        )
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(Set(object.keys) == ["password", "currentPassword"])
        #expect(object["password"] == "new-password")
        #expect(object["currentPassword"] == "old-password")
    }

    @Test
    func authSessionProjectionDecodesWithoutIdentityOrTokenMaterial() throws {
        let data = """
        {
          "sessionId": "sess_test",
          "clientId": "client_ios",
          "authMode": "passkey",
          "tokenVersion": 1,
          "createdAt": "2026-07-19T00:00:00.000Z",
          "lastSeenAt": "2026-07-19T00:01:00.000Z",
          "idleExpiresAt": "2026-07-21T00:00:00.000Z",
          "absoluteExpiresAt": "2026-08-18T00:00:00.000Z",
          "revokedAt": null,
          "revokeReason": null,
          "current": true
        }
        """.data(using: .utf8)!

        let session = try JSONDecoder().decode(NativeAuthSession.self, from: data)
        #expect(session.id == "sess_test")
        #expect(session.clientId == "client_ios")
        #expect(session.authMode == "passkey")
        #expect(session.current)
    }

    @MainActor
    @Test
    func localPreferencesAreIsolatedByOwnerAndAPIBase() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = LocalCache(rootURL: root)
        let production = URL(string: "https://athenallm.online")!
        let development = URL(string: "https://localhost:3000")!
        let preferred = AccountSettingsPreferences(appearance: .dark, accent: .green)
        try cache.saveAccountSettingsPreferences(preferred, ownerScope: "owner-a", apiBase: production)

        #expect(cache.loadAccountSettingsPreferences(ownerScope: "owner-a", apiBase: production) == preferred)
        #expect(cache.loadAccountSettingsPreferences(ownerScope: "owner-b", apiBase: production) == nil)
        #expect(cache.loadAccountSettingsPreferences(ownerScope: "owner-a", apiBase: development) == nil)
    }

    @MainActor
    @Test
    func providerStoreNeverUsesConfiguredSecretAsAVisibleDraft() {
        let secret = NativeProviderField(
            key: "DeepSeekApiKey",
            label: "API Key",
            type: "secret",
            required: true,
            secret: true,
            options: []
        )
        let model = NativeProviderField(
            key: "DeepSeekModelPref",
            label: "模型",
            type: "text",
            required: false,
            secret: false,
            options: []
        )
        let snapshot = NativeProviderSettingsSnapshot(
            success: true,
            canManage: true,
            catalog: [
                NativeProviderDescriptor(
                    id: "deepseek",
                    name: "DeepSeek",
                    supportsDynamicModels: true,
                    fields: [secret, model]
                ),
            ],
            configuration: NativeProviderConfiguration(
                provider: "deepseek",
                model: "deepseek-chat",
                values: [
                    "DeepSeekApiKey": NativeProviderFieldValue(
                        configured: true,
                        value: nil
                    ),
                    "DeepSeekModelPref": NativeProviderFieldValue(
                        configured: true,
                        value: .string("deepseek-chat")
                    ),
                ]
            ),
            version: "1",
            error: nil
        )
        let store = ProviderSettingsStore()
        store.apply(snapshot)

        #expect(store.fieldDrafts["DeepSeekApiKey"] == "")
        #expect(store.secretActions["DeepSeekApiKey"] == "keep")
        #expect(store.fieldDrafts["DeepSeekModelPref"] == "deepseek-chat")
    }

    @MainActor
    @Test
    func providerStorePreservesNewerDraftWhenAutosaveResponseArrives() {
        let model = NativeProviderField(
            key: "DeepSeekModelPref",
            label: "模型",
            type: "text",
            required: false,
            secret: false,
            options: []
        )
        let descriptor = NativeProviderDescriptor(
            id: "deepseek",
            name: "DeepSeek",
            supportsDynamicModels: true,
            fields: [model]
        )
        let initial = NativeProviderSettingsSnapshot(
            success: true,
            canManage: true,
            catalog: [descriptor],
            configuration: NativeProviderConfiguration(
                provider: "deepseek",
                model: "deepseek-chat",
                values: [
                    "DeepSeekModelPref": NativeProviderFieldValue(
                        configured: true,
                        value: .string("deepseek-chat")
                    ),
                ]
            ),
            version: "1",
            error: nil
        )
        let store = ProviderSettingsStore()
        store.apply(initial)
        store.updateField("DeepSeekModelPref", value: "deepseek-reasoner")
        let submittedRevision = store.draftRevision
        store.updateField("DeepSeekModelPref", value: "deepseek-v4-pro")

        let submittedResponse = NativeProviderSettingsSnapshot(
            success: true,
            canManage: true,
            catalog: [descriptor],
            configuration: NativeProviderConfiguration(
                provider: "deepseek",
                model: "deepseek-reasoner",
                values: [
                    "DeepSeekModelPref": NativeProviderFieldValue(
                        configured: true,
                        value: .string("deepseek-reasoner")
                    ),
                ]
            ),
            version: "2",
            error: nil
        )
        store.applySaved(submittedResponse, expectedRevision: submittedRevision)

        #expect(store.fieldDrafts["DeepSeekModelPref"] == "deepseek-v4-pro")
        #expect(store.hasUnsavedChanges)
    }

    @MainActor
    @Test
    func providerStoreRollsBackRejectedOptimisticDraft() {
        let model = NativeProviderField(
            key: "DeepSeekModelPref",
            label: "模型",
            type: "text",
            required: false,
            secret: false,
            options: []
        )
        let snapshot = NativeProviderSettingsSnapshot(
            success: true,
            canManage: true,
            catalog: [
                NativeProviderDescriptor(
                    id: "deepseek",
                    name: "DeepSeek",
                    supportsDynamicModels: true,
                    fields: [model]
                ),
            ],
            configuration: NativeProviderConfiguration(
                provider: "deepseek",
                model: "deepseek-chat",
                values: [
                    "DeepSeekModelPref": NativeProviderFieldValue(
                        configured: true,
                        value: .string("deepseek-chat")
                    ),
                ]
            ),
            version: "1",
            error: nil
        )
        let store = ProviderSettingsStore()
        store.apply(snapshot)
        store.updateField("DeepSeekModelPref", value: "deepseek-reasoner")
        let revision = store.draftRevision
        store.beginOptimisticSave(actionID: "provider-action", revision: revision)

        store.rollBackOptimisticSave(
            actionID: "provider-action",
            snapshot: snapshot,
            expectedRevision: revision
        )

        #expect(store.fieldDrafts["DeepSeekModelPref"] == "deepseek-chat")
        #expect(!store.hasUnsavedChanges)
        #expect(!store.isCurrentDraftAwaitingReconciliation)
    }

    @Test
    func providerCachePoliciesMatchTheSecurityContract() {
        #expect(ServerStateCachePolicy.providerCatalog.freshFor == 30 * 24 * 60 * 60)
        #expect(ServerStateCachePolicy.providerConfiguration.freshFor == 15 * 60)
        #expect(ServerStateCachePolicy.providerCatalog.persistence == .metadata)
        #expect(ServerStateCachePolicy.providerConfiguration.persistence == .metadata)
    }

    @Test
    func passkeyRiskDecodesWithoutCredentialMaterial() throws {
        let json = """
        {
          "methods": {
            "password": true,
            "verifiedEmail": true,
            "recoveryCodes": false,
            "passkeys": 2
          },
          "methodCount": 4,
          "requiresConfirmation": false,
          "message": null
        }
        """.data(using: .utf8)!
        let risk = try JSONDecoder().decode(NativeLoginMethodRisk.self, from: json)
        #expect(risk.methods.password)
        #expect(risk.methods.verifiedEmail)
        #expect(risk.methods.passkeys == 2)
    }
}
