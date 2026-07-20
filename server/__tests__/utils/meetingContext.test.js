jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(),
  getLLMProvider: jest.fn(),
}));
jest.mock("../../utils/dataAccess/lazyFacade", () => ({
  lazyDataAccessFacade: () => mockDocument,
  lazyDataAccessProperty: () => mockNodeSupplement,
}));
jest.mock("../../utils/chats", () => ({
  sourceIdentifier: jest.fn(() => "source"),
}));

describe("meetingContext policy", () => {
  const packet = { delegateUserId: 9 };

  it("redacts sensitive text before it can enter the model context", () => {
    const {
      applyRedactions,
    } = require("../../utils/workspaceCognition/meetingContext");
    const result = applyRedactions(
      "联系 a@example.com 或 +86 138-1234-5678，项目代号 Atlas。",
      [{ type: "email" }, { type: "phone" }, { match: "Atlas" }]
    );
    expect(result).toContain("[EMAIL]");
    expect(result).toContain("[PHONE]");
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("a@example.com");
  });

  it("downgrades unsupported facts to an explicitly labelled inference", () => {
    const {
      normalizeMeetingOutput,
    } = require("../../utils/workspaceCognition/meetingContext");
    const output = normalizeMeetingOutput(
      {
        text: "该方案一定可行。",
        metadata: {
          statementType: "fact",
          confidence: 0.9,
          evidenceRefs: ["evidence:404"],
        },
      },
      { packet, allowedEvidenceRefs: ["evidence:1"] }
    );
    expect(output.metadata.statementType).toBe("inference");
    expect(output.metadata.evidenceRefs).toEqual([]);
    expect(output.text).toBe("推论：该方案一定可行。");
  });

  it("prevents the delegate from claiming another user's position", () => {
    const {
      normalizeMeetingOutput,
    } = require("../../utils/workspaceCognition/meetingContext");
    const output = normalizeMeetingOutput(
      {
        text: "我方支持。",
        metadata: {
          statementType: "user_position",
          positionOwner: 10,
          confidence: 0.8,
        },
      },
      { packet, allowedEvidenceRefs: [] }
    );
    expect(output.metadata.statementType).toBe("inference");
    expect(output.metadata.positionOwner).toBeNull();
    expect(output.text).toMatch(/^推论：/);
  });

  it("rejects commitments without a server-approved authorization", () => {
    const {
      normalizeMeetingOutput,
    } = require("../../utils/workspaceCognition/meetingContext");
    const output = normalizeMeetingOutput(
      {
        text: "我方承诺下周交付。",
        metadata: { statementType: "commitment", confidence: 0.8 },
      },
      { packet, allowedEvidenceRefs: [], commitment: { allowed: false } }
    );
    expect(output.metadata.statementType).toBe("open_question");
    expect(output.metadata.disclosureDecision).toBe("insufficient");
    expect(output.metadata.commitmentAuthorizationId).toBeNull();
  });

  it("resolves document, directory, and knowledge-node meeting whitelists", async () => {
    mockDocument.forWorkspace.mockResolvedValue([
      { docId: "doc-explicit", docpath: "custom/one.md" },
      { docId: "doc-folder", docpath: "projects/athena/two.md" },
      { docId: "doc-node", docpath: "other/three.md" },
    ]);
    mockNodeSupplement.summariesByNodeKeys.mockResolvedValue(
      new Map([["node:athena", [{ documentId: "doc-node" }]]])
    );
    const {
      resolveWhitelistedDocumentIds,
    } = require("../../utils/workspaceCognition/meetingContext");

    const ids = await resolveWhitelistedDocumentIds({
      workspace: { id: 7 },
      packet: {
        sourceWhitelist: {
          documentIds: ["doc-explicit"],
          documentPathPrefixes: ["projects/athena/"],
          knowledgeNodeKeys: ["node:athena"],
        },
      },
    });

    expect([...ids].sort()).toEqual(
      ["doc-explicit", "doc-folder", "doc-node"].sort()
    );
  });
});
const mockDocument = { forWorkspace: jest.fn() };
const mockNodeSupplement = { summariesByNodeKeys: jest.fn() };
