const createFilesLib = require("../create-files/lib");
const {
  formatDocxBuffer,
  normalizeOutputFilename,
  rebuildDocxFromContent,
  resolveDocumentSource,
} = require("./lib");

const TOOL_NAME = "format-docx-file";
const SECURITY_ERRORS = new Set([
  "docx_source_empty",
  "docx_source_too_large",
  "invalid_docx_package",
  "unsafe_docx_archive",
  "encrypted_docx_not_supported",
  "active_docx_content_not_supported",
  "external_template_not_supported",
]);
const SAFE_ERRORS = new Set([
  ...SECURITY_ERRORS,
  "invalid_document_source",
  "workspace_context_required",
  "document_source_not_found",
  "ambiguous_document_source",
  "invalid_docx_styles",
]);

function safeErrorCode(error) {
  const message = String(error?.message || "document_formatting_failed");
  return SAFE_ERRORS.has(message) ? message : "document_formatting_failed";
}

const FormatDocxFile = {
  name: TOOL_NAME,
  plugin: function () {
    return {
      name: TOOL_NAME,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: this.name,
          description:
            "Create a professionally formatted DOCX copy from an authorized Word document in the current workspace. The source is never overwritten. Use a parsed file id, uploaded filename, or an authorized agent-generated DOCX filename as source.",
          examples: [
            {
              prompt: "把我刚上传的项目报告重新排版成专业中文 Word 文档",
              call: JSON.stringify({
                source: "项目报告.docx",
                filename: "项目报告-专业排版.docx",
                profile: "professional",
                language: "zh-CN",
                page_size: "A4",
                margins: "normal",
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              source: {
                type: "string",
                description:
                  "An uploaded filename, parsed file id, workspace document identifier, or authorized agent-generated DOCX filename in the current workspace.",
              },
              filename: {
                type: "string",
                description:
                  "Optional output filename. Defaults to formatted-<source>.docx.",
              },
              profile: {
                type: "string",
                enum: ["professional", "academic", "minimal"],
                description:
                  "Typography and spacing profile. Defaults to professional.",
              },
              language: {
                type: "string",
                enum: ["auto", "zh-CN", "en", "ja"],
                description:
                  "Document language used for font selection. Defaults to auto detection.",
              },
              page_size: {
                type: "string",
                enum: ["preserve", "A4", "Letter"],
                description:
                  "Page size for the formatted copy. Defaults to preserve.",
              },
              margins: {
                type: "string",
                enum: ["preserve", "normal", "narrow", "wide"],
                description: "Page margin preset. Defaults to preserve.",
              },
            },
            required: ["source"],
            additionalProperties: false,
          },
          handler: async function ({
            source,
            filename = null,
            profile = "professional",
            language = "auto",
            page_size = "preserve",
            margins = "preserve",
          }) {
            try {
              const resolved = await resolveDocumentSource(this.super, source);
              const outputFilename = normalizeOutputFilename(
                filename,
                resolved.displayName
              );

              if (this.super.requestToolApproval) {
                const approval = await this.super.requestToolApproval({
                  skillName: this.name,
                  payload: {
                    source: resolved.displayName,
                    filename: outputFilename,
                    profile,
                  },
                  description: `Create formatted Word copy "${outputFilename}"`,
                });
                if (!approval.approved) return approval.message;
              }

              let outputBuffer = null;
              let detectedLanguage = language;
              let mode = "preserved";
              const warnings = [];

              if (resolved.buffer) {
                try {
                  const formatted = formatDocxBuffer(resolved.buffer, {
                    profile,
                    language,
                    pageSize: page_size,
                    margins,
                  });
                  outputBuffer = formatted.buffer;
                  detectedLanguage = formatted.language;
                  if (formatted.segmentedParagraphs > 0)
                    warnings.push(
                      `segmented_long_paragraphs:${formatted.segmentedParagraphs}`
                    );
                } catch (error) {
                  if (SECURITY_ERRORS.has(String(error?.message || "")))
                    throw error;
                  if (!resolved.content) throw error;
                  mode = "reconstructed";
                  warnings.push("source_structure_rebuilt_from_parsed_content");
                }
              } else {
                mode = "reconstructed";
                warnings.push("original_docx_binary_unavailable");
              }

              if (!outputBuffer) {
                if (!resolved.content)
                  throw new Error("document_formatting_failed");
                outputBuffer = await rebuildDocxFromContent(resolved.content, {
                  profile,
                  language,
                  margins,
                  log: this.super.handlerProps.log,
                });
              }

              const savedFile = await createFilesLib.saveGeneratedFile({
                fileType: "docx",
                extension: "docx",
                buffer: outputBuffer,
                displayFilename: outputFilename,
              });
              const output = {
                filename: savedFile.displayFilename,
                storageFilename: savedFile.filename,
                fileSize: savedFile.fileSize,
              };
              this.super.socket?.send?.("fileDownloadCard", output);
              createFilesLib.registerOutput(
                this.super,
                "DocxFileDownload",
                output
              );
              return JSON.stringify({
                success: true,
                filename: outputFilename,
                mode,
                language: detectedLanguage,
                warnings,
                file_size: savedFile.fileSize,
              });
            } catch (error) {
              const code = safeErrorCode(error);
              this.super.handlerProps.log(
                `${TOOL_NAME} failed with code=${code}`
              );
              return JSON.stringify({
                success: false,
                error: code,
              });
            }
          },
        });
      },
    };
  },
};

const documentFormattingAgent = {
  name: "document-formatting-agent",
  startupConfig: { params: {} },
  plugin: [FormatDocxFile],
};

module.exports = {
  FormatDocxFile,
  documentFormattingAgent,
};
