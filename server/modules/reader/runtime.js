const access = require("./accessGate");
const classification = require("./classificationPipeline");
const documents = require("./documents");
const epub = require("./formatReaders");
const media = require("./pdfMedia");
const ocr = require("./ocr");
const postprocess = require("./postprocessPipeline");
const preview = require("./previewPipeline");

const ReaderRuntime = {
  access,
  classification,
  documents,
  epub,
  media,
  ocr,
  postprocess,
  preview,
};

module.exports = {
  ReaderRuntime,
};
