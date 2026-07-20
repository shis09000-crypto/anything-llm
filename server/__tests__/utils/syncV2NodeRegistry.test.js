const {
  classifyNodeKey,
  nodeKeys,
} = require("../../utils/syncV2/nodeRegistry");
const { SyncV2 } = require("../../models/syncV2");

describe("Sync V2 node registry", () => {
  test("uses stable database IDs and decodes preference segments", () => {
    const key = nodeKeys.userPreferences(7, "preferences.appearance", "global");
    expect(classifyNodeKey(key)).toMatchObject({
      kind: "user-preferences",
      ownerType: "user",
      ownerId: 7,
      namespace: "preferences.appearance",
      scope: "global",
    });
  });

  test("classifies cursor and monotonic models separately", () => {
    expect(classifyNodeKey("threads/9/messages").consistency).toBe(
      "event-cursor"
    );
    expect(classifyNodeKey("threads/9/read-state").consistency).toBe(
      "monotonic-cursor"
    );
    expect(classifyNodeKey("workspaces/4/tasks").consistency).toBe(
      "event-cursor"
    );
    expect(classifyNodeKey("workspaces/4/threads/index").consistency).toBe(
      "version-only"
    );
  });

  test("keeps startup authority eager and high-volume domain nodes lazy", () => {
    expect(classifyNodeKey("users/7/security/policies").hydration).toBe(
      "eager"
    );
    expect(classifyNodeKey("users/7/entitlements").hydration).toBe("eager");
    expect(classifyNodeKey("workspaces/4/documents").hydration).toBe("lazy");
    expect(classifyNodeKey("threads/9/messages").hydration).toBe("lazy");
    expect(classifyNodeKey("threads/9/metadata").hydration).toBe("lazy");
    expect(classifyNodeKey("workspaces/4/members")).toMatchObject({
      hydration: "lazy",
      hydrationTier: "route",
      payloadMode: "security-revalidate",
      costClass: "linear",
      materializeOnManifest: false,
    });
    expect(classifyNodeKey("workspaces/4/permissions")).toMatchObject({
      hydration: "lazy",
      hydrationTier: "route",
      payloadMode: "security-revalidate",
      materializeOnManifest: false,
    });
  });

  test("classifies projection cost and client application policy", () => {
    expect(classifyNodeKey("users/7/profile")).toMatchObject({
      hydrationTier: "boot-critical",
      payloadMode: "apply-payload",
      costClass: "small",
    });
    expect(classifyNodeKey("workspaces/4/documents")).toMatchObject({
      hydrationTier: "background",
      payloadMode: "apply-payload",
      costClass: "linear",
      materializeOnManifest: false,
    });
    expect(classifyNodeKey("threads/9/messages")).toMatchObject({
      hydrationTier: "route",
      payloadMode: "invalidate-only",
      costClass: "indexed",
    });
  });

  test("keeps only bounded startup preference namespaces eager", () => {
    expect(
      classifyNodeKey("users/7/preferences/preferences.appearance/global")
    ).toMatchObject({
      hydration: "eager",
      hydrationTier: "boot-critical",
      costClass: "small",
      materializeOnManifest: true,
    });
    expect(
      classifyNodeKey("users/7/preferences/recent.navigation/global")
    ).toMatchObject({
      hydration: "eager",
      hydrationTier: "navigation",
      materializeOnManifest: true,
    });
    for (const namespace of [
      "reader.library",
      "reader.progress",
      "chat.draft",
      "workspace.layout",
      "crypto.ui",
      "future.unbounded-setting",
    ]) {
      expect(
        classifyNodeKey(`users/7/preferences/${namespace}/global`)
      ).toMatchObject({
        hydration: "lazy",
        hydrationTier: "route",
        costClass: "linear",
        materializeOnManifest: false,
      });
    }
  });

  test("detects only intersecting changed paths as conflicts", () => {
    expect(SyncV2._pathsOverlap(["theme"], ["language"])).toBe(false);
    expect(SyncV2._pathsOverlap(["profile"], ["profile.bio"])).toBe(true);
  });
});
