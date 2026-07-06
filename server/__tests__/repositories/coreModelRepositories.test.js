const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../../storage");

const {
  createModelRepository,
} = require("../../repositories/createModelRepository");
const {
  WorkspaceRepository,
} = require("../../repositories/workspaceRepository");
const {
  WorkspaceThreadRepository,
} = require("../../repositories/workspaceThreadRepository");
const {
  WorkspaceChatRepository,
} = require("../../repositories/workspaceChatRepository");
const {
  DocumentRepository,
} = require("../../repositories/documentRepository");
const {
  DocumentVectorRepository,
} = require("../../repositories/documentVectorRepository");
const {
  DocumentIndexStatusRepository,
} = require("../../repositories/documentIndexStatusRepository");
const {
  WorkspaceParsedFileRepository,
} = require("../../repositories/workspaceParsedFileRepository");
const {
  EventLogRepository,
} = require("../../repositories/eventLogRepository");
const {
  TelemetryRepository,
} = require("../../repositories/telemetryRepository");

describe("core model repositories", () => {
  test("createModelRepository preserves inherited model method this binding", () => {
    const model = {
      suffix: "model",
      buildLabel(value) {
        return `${value}:${this.suffix}`;
      },
      callNested(value) {
        return this.buildLabel(value);
      },
    };
    const repository = createModelRepository(model, {
      domain: "test",
      repositoryName: "TestRepository",
    });

    repository.suffix = "repository";

    expect(repository.repositoryName).toBe("TestRepository");
    expect(repository.dataDomain).toBe("test");
    expect(repository.sourceModel).toBe(model);
    expect(repository.callNested("reader")).toBe("reader:repository");
  });

  test("sourceModel stays out of enumerable API payloads", () => {
    const repository = createModelRepository(
      { value: 1 },
      { domain: "test" }
    );

    expect(Object.keys(repository)).toEqual(["repositoryName", "dataDomain"]);
  });

  test("workspace repository exposes the existing workspace model contract", () => {
    expect(WorkspaceRepository.repositoryName).toBe("WorkspaceRepository");
    expect(WorkspaceRepository.dataDomain).toBe("workspace");
    expect(WorkspaceRepository.VALID_CHAT_MODES).toEqual([
      "chat",
      "query",
      "automatic",
    ]);
    expect(typeof WorkspaceRepository.new).toBe("function");
    expect(typeof WorkspaceRepository.get).toBe("function");
  });

  test("thread and chat repositories expose existing model contracts", () => {
    expect(WorkspaceThreadRepository.repositoryName).toBe(
      "WorkspaceThreadRepository"
    );
    expect(WorkspaceThreadRepository.THREAD_TYPES.chat).toBe("chat");
    expect(typeof WorkspaceThreadRepository.new).toBe("function");

    expect(WorkspaceChatRepository.repositoryName).toBe(
      "WorkspaceChatRepository"
    );
    expect(typeof WorkspaceChatRepository.new).toBe("function");
    expect(typeof WorkspaceChatRepository.forWorkspace).toBe("function");
  });

  test("document data repositories expose existing model contracts", () => {
    expect(DocumentRepository.repositoryName).toBe("DocumentRepository");
    expect(typeof DocumentRepository.get).toBe("function");
    expect(typeof DocumentRepository.addDocuments).toBe("function");

    expect(DocumentVectorRepository.repositoryName).toBe(
      "DocumentVectorRepository"
    );
    expect(typeof DocumentVectorRepository.deleteForWorkspace).toBe("function");

    expect(DocumentIndexStatusRepository.repositoryName).toBe(
      "DocumentIndexStatusRepository"
    );
    expect(DocumentIndexStatusRepository.statuses.pending).toBe("pending");
    expect(typeof DocumentIndexStatusRepository.upsertPending).toBe("function");

    expect(WorkspaceParsedFileRepository.repositoryName).toBe(
      "WorkspaceParsedFileRepository"
    );
    expect(typeof WorkspaceParsedFileRepository.create).toBe("function");
  });

  test("observability repositories expose existing model contracts", () => {
    expect(EventLogRepository.repositoryName).toBe("EventLogRepository");
    expect(typeof EventLogRepository.logEvent).toBe("function");

    expect(TelemetryRepository.repositoryName).toBe("TelemetryRepository");
    expect(typeof TelemetryRepository.sendTelemetry).toBe("function");
  });
});
