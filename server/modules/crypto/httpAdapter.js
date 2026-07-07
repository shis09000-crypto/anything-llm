const { cryptoCenterEndpoints } = require("./httpCenterHandlers");
const { cryptoHubEndpoints } = require("./httpHubHandlers");
const { cryptoGateProbeEndpoints } = require("./httpGateHandlers");

function registerCryptoCenterRoutes(app) {
  return cryptoCenterEndpoints(app);
}

function registerCryptoHubRoutes(app) {
  return cryptoHubEndpoints(app);
}

function registerCryptoGateRoutes(app) {
  return cryptoGateProbeEndpoints(app);
}

function registerCryptoRoutes(app) {
  registerCryptoCenterRoutes(app);
  registerCryptoHubRoutes(app);
  registerCryptoGateRoutes(app);
}

module.exports = {
  registerCryptoCenterRoutes,
  registerCryptoHubRoutes,
  registerCryptoGateRoutes,
  registerCryptoRoutes,
};
