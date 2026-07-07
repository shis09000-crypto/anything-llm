const {
  issueReaderDebugAccessGrant,
  readerDebugAccessGrantSnapshot,
  READER_DEBUG_ACCESS_HEADER,
  revokeReaderDebugAccessGrant,
  validateReaderDebugAccessGrantForRequest,
} = require("../../utils/devControl/readerDebugAccess");

function requestWithGrant(debugGrantId, clientId = "client-a") {
  return {
    headers: {
      [READER_DEBUG_ACCESS_HEADER.toLowerCase()]: debugGrantId,
      "x-athena-client-id": clientId,
    },
    header(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
}

function responseForUser(userId = 7) {
  return {
    locals: {
      user: { id: userId },
    },
  };
}

describe("Reader debug access grants", () => {
  test("allows a short-lived current-client grant for the target document", () => {
    const grant = issueReaderDebugAccessGrant({
      userId: 7,
      clientId: "client-a",
      workspaceSlug: "workspace-a",
      readerDocumentId: "reader-doc-1",
      endpoints: ["original"],
    });

    expect(grant.headerName).toBe(READER_DEBUG_ACCESS_HEADER);
    expect(grant.debugGrantId).toMatch(/^rdg_/);

    const result = validateReaderDebugAccessGrantForRequest(
      requestWithGrant(grant.debugGrantId),
      responseForUser(7),
      {
        workspaceSlug: "workspace-a",
        readerDocumentId: "reader-doc-1",
        endpoint: "original",
      }
    );
    expect(result.ok).toBe(true);
  });

  test("rejects wrong client, wrong endpoint, and revoked grants", () => {
    const grant = issueReaderDebugAccessGrant({
      userId: 7,
      clientId: "client-a",
      workspaceSlug: null,
      readerDocumentId: "reader-doc-2",
      endpoints: ["preview.pdf"],
    });

    expect(
      validateReaderDebugAccessGrantForRequest(
        requestWithGrant(grant.debugGrantId, "client-b"),
        responseForUser(7),
        {
          workspaceSlug: null,
          readerDocumentId: "reader-doc-2",
          endpoint: "preview.pdf",
        }
      ).reason
    ).toBe("client_mismatch");

    expect(
      validateReaderDebugAccessGrantForRequest(
        requestWithGrant(grant.debugGrantId),
        responseForUser(7),
        {
          workspaceSlug: null,
          readerDocumentId: "reader-doc-2",
          endpoint: "original",
        }
      ).reason
    ).toBe("endpoint_mismatch");

    expect(
      revokeReaderDebugAccessGrant({
        debugGrantId: grant.debugGrantId,
        userId: 7,
        clientId: "client-a",
      })
    ).toBe(true);
    expect(
      validateReaderDebugAccessGrantForRequest(
        requestWithGrant(grant.debugGrantId),
        responseForUser(7),
        {
          workspaceSlug: null,
          readerDocumentId: "reader-doc-2",
          endpoint: "preview.pdf",
        }
      ).ok
    ).toBe(false);
  });

  test("snapshot redacts the bearer grant id", () => {
    const grant = issueReaderDebugAccessGrant({
      userId: 8,
      clientId: "client-c",
      readerDocumentId: "reader-doc-3",
      endpoints: ["page-preview"],
    });
    const snapshot = readerDebugAccessGrantSnapshot({
      userId: 8,
      clientId: "client-c",
    });

    expect(JSON.stringify(snapshot)).not.toContain(grant.debugGrantId);
    expect(snapshot[0]).toMatchObject({
      debugGrantId: "[redacted-reader-debug-grant]",
      readerDocumentId: "reader-doc-3",
      endpoints: ["page-preview"],
    });
  });
});
