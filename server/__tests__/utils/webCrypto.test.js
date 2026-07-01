const { ensureWebCrypto, hasUsableWebCrypto } = require("../../utils/security/webCrypto");

describe("webCrypto bootstrap", () => {
  test("ensures a WebCrypto implementation is available for WebAuthn", () => {
    const originalCrypto = globalThis.crypto;
    const hadCrypto = Object.prototype.hasOwnProperty.call(
      globalThis,
      "crypto"
    );

    try {
      Object.defineProperty(globalThis, "crypto", {
        value: undefined,
        configurable: true,
        writable: true,
      });

      expect(hasUsableWebCrypto()).toBe(false);
      expect(ensureWebCrypto()).toBe(true);
      expect(hasUsableWebCrypto()).toBe(true);
      expect(typeof globalThis.crypto.getRandomValues).toBe("function");
      expect(globalThis.crypto.subtle).toBeTruthy();
    } finally {
      if (hadCrypto) {
        Object.defineProperty(globalThis, "crypto", {
          value: originalCrypto,
          configurable: true,
          writable: true,
        });
      } else {
        delete globalThis.crypto;
      }
    }
  });
});
