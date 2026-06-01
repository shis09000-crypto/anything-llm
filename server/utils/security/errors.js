class EncryptionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

class EncryptionFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "EncryptionFormatError";
  }
}

class EncryptionOperationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EncryptionOperationError";
  }
}

module.exports = {
  EncryptionConfigError,
  EncryptionFormatError,
  EncryptionOperationError,
};
