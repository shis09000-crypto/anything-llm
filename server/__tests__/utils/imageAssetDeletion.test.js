const mockDataAccessCenter = {
  imageAsset: {
    beginDelete: jest.fn(),
    finalizeDelete: jest.fn(),
    setProviderStatus: jest.fn(),
    pendingDeletion: jest.fn(),
  },
  contentObject: {
    providerFilesForImageAsset: jest.fn(),
    deleteProviderFileBinding: jest.fn(),
    invalidateProviderFileBinding: jest.fn(),
    release: jest.fn(),
  },
};
const mockDeleteDeepSeekFile = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: mockDataAccessCenter,
}));
jest.mock("../../utils/imageAssets/adapter", () => ({
  deleteDeepSeekFile: mockDeleteDeepSeekFile,
  resolveImageInput: jest.fn(),
}));

const {
  deleteImageAsset,
} = require("../../utils/imageAssets/service");

describe("image asset deletion lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDataAccessCenter.imageAsset.beginDelete.mockResolvedValue({
      id: "image-1",
      status: "deleting",
      workspaceId: 7,
      originalContentObjectId: "original-1",
      previewContentObjectId: "preview-1",
      attachmentReferenceCount: 2,
    });
    mockDataAccessCenter.contentObject.providerFilesForImageAsset.mockResolvedValue([
      {
        id: "binding-1",
        providerFileId: "file-deepseek-1",
        derivativeAssetId: "derivative-1",
      },
    ]);
    mockDeleteDeepSeekFile.mockResolvedValue(true);
    mockDataAccessCenter.contentObject.deleteProviderFileBinding.mockResolvedValue({
      count: 1,
    });
    mockDataAccessCenter.contentObject.invalidateProviderFileBinding.mockResolvedValue(
      true
    );
    mockDataAccessCenter.contentObject.release.mockResolvedValue(true);
    mockDataAccessCenter.imageAsset.finalizeDelete.mockResolvedValue({
      id: "image-1",
      status: "deleted",
    });
  });

  test("deletes provider file, releases all content and retains a tombstone", async () => {
    const result = await deleteImageAsset({
      assetId: "image-1",
      workspaceId: 7,
      userId: 3,
    });
    expect(result.completed).toBe(true);
    expect(mockDeleteDeepSeekFile).toHaveBeenCalledWith(
      "file-deepseek-1",
      expect.any(Object)
    );
    expect(mockDataAccessCenter.contentObject.deleteProviderFileBinding).toHaveBeenCalledWith(
      "binding-1"
    );
    expect(mockDataAccessCenter.contentObject.release).toHaveBeenCalledWith(
      "original-1",
      2
    );
    expect(mockDataAccessCenter.contentObject.release).toHaveBeenCalledWith(
      "original-1",
      1
    );
    expect(mockDataAccessCenter.contentObject.release).toHaveBeenCalledWith(
      "preview-1",
      1
    );
    expect(mockDataAccessCenter.imageAsset.finalizeDelete).toHaveBeenCalledWith(
      "image-1"
    );
  });

  test("keeps deletion pending when provider cleanup fails", async () => {
    mockDeleteDeepSeekFile.mockRejectedValue(
      Object.assign(new Error("provider failed"), { code: "provider_delete_failed" })
    );
    const result = await deleteImageAsset({
      assetId: "image-1",
      workspaceId: 7,
      userId: 3,
    });
    expect(result.completed).toBe(false);
    expect(mockDataAccessCenter.imageAsset.setProviderStatus).toHaveBeenCalledWith(
      "image-1",
      "delete_pending",
      "provider_delete_failed"
    );
    expect(mockDataAccessCenter.contentObject.release).toHaveBeenCalledWith(
      "original-1",
      2
    );
    expect(mockDataAccessCenter.imageAsset.finalizeDelete).not.toHaveBeenCalled();
  });
});
