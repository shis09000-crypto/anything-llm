const classificationPipeline = require("./classificationPipeline");
const documentCatalog = require("./documentCatalog");
const ocr = require("./ocr");

async function listDocuments(request, response) {
  try {
    const documents = await documentCatalog.listReaderDocumentsForWorkspace({
      request,
      response,
      workspace: response.locals.workspace,
    });
    return response.status(200).json({ success: true, documents });
  } catch (error) {
    return response.status(400).json({ success: false, error: error.message });
  }
}

async function classify(request, response) {
  const result =
    await classificationPipeline.classifyReaderDocumentWithDeepSeek(
      request.body || {}
    );
  return response.status(200).json(result);
}

function ocrConfig(_request, response) {
  return response.status(200).json(ocr.readerOcrConfigStatus());
}

async function ocrScreenshot(request, response) {
  try {
    const result = await ocr.recognizeReaderScreenshot(request.body || {});
    return response.status(200).json(result);
  } catch (error) {
    return response.status(error.status || 500).json({
      success: false,
      error: error.message || "OCR request failed.",
    });
  }
}

module.exports = {
  classify,
  listDocuments,
  ocrConfig,
  ocrScreenshot,
};
