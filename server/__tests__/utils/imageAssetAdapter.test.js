const sharp = require("sharp");
const {
  ADAPTATION_VERSION,
  clearUploadFlights,
  resolveImageInput,
  reusableBinding,
} = require("../../utils/imageAssets/adapter");

async function pngBuffer() {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function persistentRef() {
  return {
    kind: "persistent",
    assetId: "asset-1",
    name: "original.png",
    mimeType: "image/png",
    byteSize: 1,
    sha256: "source-sha",
    detail: "original",
  };
}

function dataAccessMock(buffer) {
  const bindings = new Map();
  const key = (data) =>
    [
      data.imageAssetId,
      data.provider,
      data.credentialScopeHash,
      data.adaptationVersion,
    ].join(":");
  return {
    bindings,
    imageAsset: {
      getForModel: jest.fn(async () => ({
        id: "asset-1",
        originalContentObjectId: "content-object-1",
      })),
    },
    contentObject: {
      providerFileBinding: jest.fn(async (data) => bindings.get(key(data))),
      saveProviderFileBinding: jest.fn(async (data) => {
        const row = { id: `binding-${bindings.size + 1}`, ...data };
        bindings.set(key(data), row);
        return row;
      }),
      touchProviderFileBinding: jest.fn(async () => true),
      assetForWorkspace: jest.fn(async () => ({
        id: "content-object-1",
        mimeType: "image/png",
      })),
      readWhole: jest.fn(async () => buffer),
      stageBuffer: jest.fn(),
      scheduleDelete: jest.fn(async () => true),
      retain: jest.fn(async () => true),
      release: jest.fn(async () => true),
    },
  };
}

describe("persistent image asset adapter", () => {
  beforeEach(() => clearUploadFlights());

  test("uploads once and reuses the durable provider mapping", async () => {
    const dataAccess = dataAccessMock(await pngBuffer());
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: "file-deepseek-1",
        expires_at: Math.floor(Date.now() / 1_000) + 30 * 24 * 60 * 60,
      }),
    }));
    const options = {
      workspaceId: 7,
      env: { DEEPSEEK_API_KEY: "scope-a" },
      fetchImpl,
      dataAccess,
    };
    await expect(
      resolveImageInput(persistentRef(), options)
    ).resolves.toMatchObject({
      type: "input_image",
      file_id: "file-deepseek-1",
      assetId: "asset-1",
    });
    await expect(
      resolveImageInput(persistentRef(), options)
    ).resolves.toMatchObject({ file_id: "file-deepseek-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(dataAccess.contentObject.stageBuffer).not.toHaveBeenCalled();
    expect(
      dataAccess.contentObject.saveProviderFileBinding.mock.calls[0][0]
        .adaptationVersion
    ).toBe(ADAPTATION_VERSION);
  });

  test("does not reuse files within the renewal window", () => {
    expect(
      reusableBinding({
        status: "ready",
        providerFileId: "file-old",
        expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      })
    ).toBe(false);
  });

  test("retires an obsolete provider derivative after a refreshed upload", async () => {
    const dataAccess = dataAccessMock(await pngBuffer());
    dataAccess.contentObject.providerFileBinding.mockResolvedValue({
      id: "binding-old",
      assetId: "content-object-1",
      imageAssetId: "asset-1",
      derivativeAssetId: "derivative-old",
      providerFileId: "file-old",
      status: "invalid",
    });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "file-new" }),
    }));

    await resolveImageInput(persistentRef(), {
      workspaceId: 7,
      env: { DEEPSEEK_API_KEY: "scope-a" },
      fetchImpl,
      dataAccess,
      forceRefresh: true,
    });

    expect(dataAccess.contentObject.release).toHaveBeenCalledWith(
      "derivative-old",
      1
    );
  });

  test("keeps ephemeral frames in the current request without Files API", async () => {
    const dataUrl = "data:image/jpeg;base64,ZmFrZQ==";
    await expect(
      resolveImageInput({
        kind: "ephemeral",
        source: "computer_use",
        dataUrl,
        mimeType: "image/jpeg",
        sha256: "fake",
        capturedAt: new Date().toISOString(),
        detail: "original",
        retention: "turn",
      })
    ).resolves.toEqual({
      type: "input_image",
      image_url: dataUrl,
      detail: "original",
    });
  });
});
