const {
  decodeAttachmentContent,
  validateAttachmentBatch,
} = require("../../utils/contentObjects/policy");
const { truncateUtf8 } = require("../../utils/contentObjects/chatPayload");

describe("content object chat policy", () => {
  it("preserves UTF-8 boundaries in assistant previews", () => {
    const preview = truncateUtf8("A你B好C", 5);
    expect(preview).toBe("A你B");
    expect(Buffer.byteLength(preview, "utf8")).toBeLessThanOrEqual(5);
  });

  it("rejects per-file, aggregate, and count overflow", () => {
    const inline = (bytes) => ({
      name: "payload.bin",
      contentString: Buffer.alloc(bytes, 1).toString("base64"),
    });
    expect(() =>
      validateAttachmentBatch([inline(5)], {
        maxFileBytes: 4,
        maxTurnBytes: 10,
        maxFilesPerTurn: 2,
      })
    ).toThrow("chat_attachment_too_large");
    expect(() =>
      validateAttachmentBatch([inline(4), inline(4)], {
        maxFileBytes: 5,
        maxTurnBytes: 7,
        maxFilesPerTurn: 2,
      })
    ).toThrow("chat_attachment_turn_too_large");
    expect(() =>
      validateAttachmentBatch([inline(1), inline(1), inline(1)], {
        maxFileBytes: 5,
        maxTurnBytes: 10,
        maxFilesPerTurn: 2,
      })
    ).toThrow("chat_attachment_count_exceeded");
  });

  it("accepts data URLs without losing MIME metadata", () => {
    const decoded = decodeAttachmentContent(
      `data:image/png;base64,${Buffer.from("png").toString("base64")}`
    );
    expect(decoded.dataUrlMime).toBe("image/png");
    expect(decoded.buffer.toString("utf8")).toBe("png");
  });
});
