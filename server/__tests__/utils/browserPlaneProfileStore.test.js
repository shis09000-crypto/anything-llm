const fs = require("fs");
const os = require("os");
const path = require("path");

let mockObjectRoot = null;

jest.mock("../../providers/storage/contentObjectProvider", () => ({
  contentObjectProvider: () => {
    const mockFs = require("fs");
    const mockPath = require("path");
    return {
      async putImmutableFile({ objectKey, sourcePath }) {
        const target = mockPath.join(mockObjectRoot, objectKey);
        await mockFs.promises.mkdir(mockPath.dirname(target), {
          recursive: true,
        });
        await mockFs.promises.copyFile(sourcePath, target);
        return { created: true };
      },
      async stat({ objectKey }) {
        try {
          const stat = await mockFs.promises.stat(
            mockPath.join(mockObjectRoot, objectKey)
          );
          return { exists: true, size: stat.size };
        } catch {
          return { exists: false, size: null };
        }
      },
      async writeToFile({ objectKey, destinationPath }) {
        await mockFs.promises.copyFile(
          mockPath.join(mockObjectRoot, objectKey),
          destinationPath
        );
      },
      async delete({ objectKey }) {
        await mockFs.promises.rm(mockPath.join(mockObjectRoot, objectKey), {
          force: true,
        });
      },
    };
  },
}));

jest.mock("../../utils/security/keyCustody/remoteClient", () => ({
  wrapMaterial: async (value) => `wrapped:${value}`,
  unwrapMaterial: async (value) => String(value).slice("wrapped:".length),
}));

describe("Browser Plane encrypted cloud profiles", () => {
  let root;
  let profileStore;

  beforeAll(async () => {
    root = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "athena-browser-profile-test-")
    );
    mockObjectRoot = path.join(root, "objects");
    process.env.BROWSER_WORKER_PROFILE_ROOT = path.join(root, "runtime");
    profileStore = require("../../utils/browserPlane/profileStore");
  });

  afterAll(async () => {
    delete process.env.BROWSER_WORKER_PROFILE_ROOT;
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  test("checkpoint encrypts, removes caches, and restores exact profile data", async () => {
    const profileId = "profile-roundtrip";
    const activeDir = profileStore.paths(profileId).activeDir;
    await fs.promises.mkdir(path.join(activeDir, "Default", "Cache"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(activeDir, "Preferences"),
      "browser-secret-state",
      { mode: 0o600 }
    );
    await fs.promises.writeFile(
      path.join(activeDir, "Default", "Cache", "ephemeral"),
      "discard-me"
    );

    const checkpoint = await profileStore.checkpointProfile(profileId);
    expect(checkpoint).toMatchObject({
      checkpointed: true,
      profileId,
    });
    const ciphertext = await fs.promises.readFile(
      path.join(mockObjectRoot, checkpoint.objectRef)
    );
    expect(ciphertext.includes(Buffer.from("browser-secret-state"))).toBe(
      false
    );

    await fs.promises.rm(activeDir, { recursive: true, force: true });
    const restored = await profileStore.restoreProfile(profileId, {
      objectRef: checkpoint.objectRef,
      manifest: checkpoint.manifest,
    });
    expect(restored.restored).toBe(true);
    await expect(
      fs.promises.readFile(path.join(activeDir, "Preferences"), "utf8")
    ).resolves.toBe("browser-secret-state");
    await expect(
      fs.promises.stat(path.join(activeDir, "Default", "Cache", "ephemeral"))
    ).rejects.toMatchObject({ code: "ENOENT" });

    await profileStore.deleteProfile(profileId, {
      objectRef: checkpoint.objectRef,
    });
  });
});
