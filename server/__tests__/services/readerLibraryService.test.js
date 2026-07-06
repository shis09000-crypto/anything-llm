const mockAuthority = {
  readerLibrary: {
    listLibrary: jest.fn(),
    bootstrap: jest.fn(),
    patchItem: jest.fn(),
    softDeleteItem: jest.fn(),
    patchCategory: jest.fn(),
    reconcileCatalog: jest.fn(),
  },
};

const mockPublishBroadcastEvent = jest.fn();

jest.mock("../../utils/dataAccess", () => ({
  DataAccessCenter: mockAuthority,
}));

jest.mock("../../utils/broadcast", () => ({
  publishBroadcastEvent: mockPublishBroadcastEvent,
}));

const {
  ReaderLibraryService,
  libraryResponse,
} = require("../../services/readerLibraryService");

describe("ReaderLibraryService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("list reads from authority without publishing a broadcast event", async () => {
    mockAuthority.readerLibrary.listLibrary.mockResolvedValueOnce({
      revision: "r1",
      bookshelf: [],
      categories: [],
    });

    const result = await ReaderLibraryService.list({ userId: 7 });

    expect(result.revision).toBe("r1");
    expect(mockAuthority.readerLibrary.listLibrary).toHaveBeenCalledWith({
      userId: 7,
    });
    expect(mockPublishBroadcastEvent).not.toHaveBeenCalled();
  });

  test("bootstrap writes through authority and publishes a small reader event", async () => {
    mockAuthority.readerLibrary.bootstrap.mockResolvedValueOnce({
      revision: "r2",
      bookshelf: [{ title: "A" }],
      categories: [],
    });

    const result = await ReaderLibraryService.bootstrap({
      userId: 7,
      bookshelf: [{ title: "A" }],
      categories: [],
    });

    expect(result.bookshelf).toHaveLength(1);
    expect(mockAuthority.readerLibrary.bootstrap).toHaveBeenCalledWith({
      userId: 7,
      bookshelf: [{ title: "A" }],
      categories: [],
    });
    expect(mockPublishBroadcastEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "reader",
        type: "library.bootstrapped",
        scope: { userId: 7 },
        resource: { kind: "reader-library", id: "7" },
      }),
      { coalesce: true }
    );
  });

  test("missing patch target does not publish a stale item update", async () => {
    mockAuthority.readerLibrary.patchItem.mockResolvedValueOnce(null);

    const result = await ReaderLibraryService.patchItem({
      userId: 7,
      itemId: "missing",
      patch: { title: "Nope" },
    });

    expect(result).toBeNull();
    expect(mockPublishBroadcastEvent).not.toHaveBeenCalled();
  });

  test("libraryResponse keeps the stable reader-library API shape", () => {
    expect(libraryResponse({})).toEqual({
      success: true,
      revision: null,
      categories: [],
      bookshelf: [],
      counts: {
        categories: 0,
        bookshelf: 0,
      },
    });
  });
});
