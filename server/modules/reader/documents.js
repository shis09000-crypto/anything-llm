const documentCatalog = require("./documentCatalog");
const documentsCore = require("./documentsCore");
const originalStream = require("./originalStream");
const readerLinks = require("./readerLinks");

module.exports = {
  ...documentsCore,
  duplicateSignatureFor: documentCatalog.duplicateSignatureFor,
  extractReaderDuplicateLeadText:
    documentCatalog.extractReaderDuplicateLeadText,
  findReaderDuplicateCandidate: documentCatalog.findReaderDuplicateCandidate,
  listReaderDocumentsForWorkspace:
    documentCatalog.listReaderDocumentsForWorkspace,
  metadataWithOriginalUrl: readerLinks.metadataWithOriginalUrl,
  readerApiPrefix: readerLinks.readerApiPrefix,
  readAuthorizedStandaloneReaderMetadata:
    documentCatalog.readAuthorizedStandaloneReaderMetadata,
  readerOriginalEtag: originalStream.readerOriginalEtag,
  setReaderOriginalHeaders: originalStream.setReaderOriginalHeaders,
};
