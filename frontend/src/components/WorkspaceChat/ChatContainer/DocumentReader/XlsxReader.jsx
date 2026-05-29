import { useMemo, useState } from "react";
import { Quotes } from "@phosphor-icons/react";
import { markdownTableFromRange } from "./parsers";
import { textHash } from "./storage";

export default function XlsxReader({ document, onCite }) {
  const sheets = document?.content?.sheets || [];
  const [activeSheet, setActiveSheet] = useState(sheets[0]?.name || "");
  const [selection, setSelection] = useState(null);
  const sheet = useMemo(
    () => sheets.find((item) => item.name === activeSheet) || sheets[0],
    [activeSheet, sheets]
  );
  const rows = sheet?.rows || [];

  function selectCell(rowIndex, colIndex) {
    setSelection((prev) =>
      !prev || prev.complete
        ? {
            startRow: rowIndex,
            startCol: colIndex,
            endRow: rowIndex,
            endCol: colIndex,
          }
        : { ...prev, endRow: rowIndex, endCol: colIndex, complete: true }
    );
  }

  function isSelected(rowIndex, colIndex) {
    if (!selection) return false;
    const minRow = Math.min(selection.startRow, selection.endRow);
    const maxRow = Math.max(selection.startRow, selection.endRow);
    const minCol = Math.min(selection.startCol, selection.endCol);
    const maxCol = Math.max(selection.startCol, selection.endCol);
    return (
      rowIndex >= minRow &&
      rowIndex <= maxRow &&
      colIndex >= minCol &&
      colIndex <= maxCol
    );
  }

  function citeRange() {
    const table = markdownTableFromRange(sheet.name, rows, selection);
    if (!table?.text) return;
    onCite({
      source: document.source,
      documentTitle: document.title,
      documentType: "xlsx",
      readerDocumentId: document.readerDocumentId,
      localDocumentId: document.localDocumentId,
      backupReaderDocumentId: document.backupReaderDocumentId,
      selectedText: table.text,
      textHash: textHash(table.text),
      locator: { sheetName: table.sheetName, range: table.range },
      locatorLabel: `${table.sheetName} ${table.range}`,
    });
  }

  if (!sheet) {
    return (
      <p className="text-sm text-white/50 light:text-slate-500">
        没有可显示的 sheet。
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 overflow-x-auto">
        {sheets.map((item) => (
          <button
            key={item.name}
            type="button"
            onClick={() => {
              setActiveSheet(item.name);
              setSelection(null);
            }}
            className={`rounded-md px-3 py-1 text-xs ${
              item.name === sheet.name
                ? "bg-sky-500 text-white"
                : "bg-white/5 text-white/70 light:bg-slate-100 light:text-slate-700"
            }`}
          >
            {item.name}
          </button>
        ))}
        <button
          type="button"
          onClick={citeRange}
          disabled={!selection}
          className="ml-auto flex items-center gap-1 rounded-md bg-white/10 px-3 py-1 text-xs text-white disabled:opacity-40 light:bg-slate-100 light:text-slate-700"
        >
          <Quotes size={13} />
          引用选区
        </button>
      </div>
      <div className="overflow-auto rounded-md border border-white/10 light:border-slate-200">
        <table className="min-w-full border-collapse text-xs">
          <tbody>
            {rows.slice(0, 500).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.slice(0, 80).map((cell, colIndex) => (
                  <td
                    key={`${rowIndex}-${colIndex}`}
                    onClick={() => selectCell(rowIndex, colIndex)}
                    className={`max-w-[220px] cursor-pointer truncate border border-white/10 px-2 py-1 light:border-slate-200 ${
                      isSelected(rowIndex, colIndex)
                        ? "bg-sky-500/25 text-sky-100 light:text-sky-800"
                        : "text-white/80 light:text-slate-700"
                    }`}
                  >
                    {String(cell ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
