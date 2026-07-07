const { CryptoRuntime } = require("./runtime");

module.exports = {
  CryptoRuntime,
  registerCryptoCenterRoutes(...args) {
    return require("./httpAdapter").registerCryptoCenterRoutes(...args);
  },
  registerCryptoHubRoutes(...args) {
    return require("./httpAdapter").registerCryptoHubRoutes(...args);
  },
  registerCryptoGateRoutes(...args) {
    return require("./httpAdapter").registerCryptoGateRoutes(...args);
  },
  registerCryptoRoutes(...args) {
    return require("./httpAdapter").registerCryptoRoutes(...args);
  },
};
