jest.mock("../../utils/readerDocumentRuntime", () => ({
  STANDALONE_READER_SCOPE: { slug: "global-reader", readerStandalone: true },
  readerPreviewEngineStatus: jest.fn(() => ({
    available: true,
    binary: "/usr/bin/libreoffice",
    version: "test",
  })),
  runReaderPostprocessJob: jest.fn(async () => undefined),
}));

jest.mock("../../utils/dataAccess/dataAccessCenter", () => ({
  DataAccessCenter: {
    readerWorkerJob: {
      claimNext: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
      snapshot: jest.fn(async () => ({
        enabled: true,
        byStatus: {},
        byTask: {},
        recent: [],
      })),
    },
    workspace: {
      get: jest.fn(async () => ({ slug: "workspace-a" })),
    },
  },
}));

const { ReaderWorkerRuntime } = require("../../utils/readerWorker/runtime");
const { DataAccessCenter } = require("../../utils/dataAccess/dataAccessCenter");
const {
  runReaderPostprocessJob,
} = require("../../utils/readerDocumentRuntime");

describe("ReaderWorkerRuntime", () => {
  afterEach(() => {
    delete process.env.ATHENA_READER_WORKER_QUEUE;
    jest.clearAllMocks();
  });

  test("snapshot exposes P3 worker boundary without attaching disabled queue", () => {
    const runtime = new ReaderWorkerRuntime({
      now: () => new Date("2026-07-07T00:00:00.000Z"),
    });

    expect(runtime.snapshot()).toMatchObject({
      role: "reader-worker",
      status: "idle",
      startedAt: "2026-07-07T00:00:00.000Z",
      queue: {
        mode: "disabled",
        attached: false,
      },
      tasks: expect.arrayContaining([
        "postprocess",
        "preview",
        "thumbnail",
        "classification",
      ]),
      events: expect.arrayContaining([
        "reader.preview.ready",
        "reader.thumbnail.ready",
        "reader.classification.ready",
      ]),
      previewEngine: {
        available: true,
        binary: "/usr/bin/libreoffice",
      },
    });
  });

  test("disabled durable queue does not claim jobs", async () => {
    const runtime = new ReaderWorkerRuntime();
    await expect(runtime.processOne()).resolves.toBeNull();
  });

  test("enabled durable queue claims and executes postprocess jobs", async () => {
    process.env.ATHENA_READER_WORKER_QUEUE = "true";
    DataAccessCenter.readerWorkerJob.claimNext.mockResolvedValueOnce({
      jobId: "job-1",
      task: "postprocess",
      readerDocumentId: "doc-1",
      workspaceSlug: "workspace-a",
      userId: 7,
      payload: {
        tasks: ["preview", "thumbnail"],
        categories: [{ id: "finance", name: "Finance" }],
      },
    });
    const runtime = new ReaderWorkerRuntime({
      now: () => new Date("2026-07-07T00:00:00.000Z"),
      workerId: "test-worker",
    });

    await expect(runtime.processOne()).resolves.toEqual({
      jobId: "job-1",
      status: "completed",
    });
    expect(DataAccessCenter.workspace.get).toHaveBeenCalledWith({
      slug: "workspace-a",
    });
    expect(runReaderPostprocessJob).toHaveBeenCalledWith({
      workspace: { slug: "workspace-a" },
      readerDocumentId: "doc-1",
      tasks: ["preview", "thumbnail"],
      categories: [{ id: "finance", name: "Finance" }],
      userId: 7,
    });
    expect(DataAccessCenter.readerWorkerJob.complete).toHaveBeenCalledWith(
      "job-1",
      {
        completedTasks: ["preview", "thumbnail"],
        readerDocumentId: "doc-1",
        workspaceSlug: "workspace-a",
      }
    );
  });
});
