const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");
const {
  fingerprintForBuffer,
  fingerprintForFile,
  xlsxContentProjection,
} = require("../../modules/reader/ingestCore");

describe("reader ingest streaming helpers", () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "athena-reader-test-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("hashes a file without changing the canonical fingerprint", async () => {
    const buffer = Buffer.from("reader-streaming-fingerprint");
    const filePath = path.join(directory, "sample.bin");
    fs.writeFileSync(filePath, buffer);
    await expect(fingerprintForFile(filePath)).resolves.toBe(
      fingerprintForBuffer(buffer)
    );
  });

  it("creates a bounded server-owned XLSX projection", async () => {
    const filePath = path.join(directory, "sample.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.addRow(["name", "value"]);
    sheet.addRow(["alpha", 42]);
    await workbook.xlsx.writeFile(filePath);

    const projection = await xlsxContentProjection({
      readerDocumentId: "reader-id",
      originalPath: filePath,
    });
    expect(projection).toMatchObject({
      readerDocumentId: "reader-id",
      documentType: "xlsx",
      sheets: [
        {
          name: "Data",
          rows: [
            ["name", "value"],
            ["alpha", "42"],
          ],
        },
      ],
      projection: { source: "server", truncated: false, cellCount: 4 },
    });
  });

  it("marks the XLSX projection truncated at the configured cell cap", async () => {
    const filePath = path.join(directory, "capped.xlsx");
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Data").addRow(["one", "two", "three"]);
    await workbook.xlsx.writeFile(filePath);

    const projection = await xlsxContentProjection({
      readerDocumentId: "reader-id",
      originalPath: filePath,
      maxCells: 2,
    });
    expect(projection.projection).toMatchObject({
      truncated: true,
      cellCount: 2,
    });
  });
});
