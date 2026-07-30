const { cryptoCenterEndpoints } = require("./httpCenterHandlers");
const { cryptoHubEndpoints } = require("./httpHubHandlers");
const { cryptoGateProbeEndpoints } = require("./httpGateHandlers");
const { cryptoForecastingEndpoints } = require("./httpForecastingHandlers");

function registerCryptoCenterRoutes(app) {
  return cryptoCenterEndpoints(app);
}

function registerCryptoHubRoutes(app) {
  return cryptoHubEndpoints(app);
}

function registerCryptoGateRoutes(app) {
  return cryptoGateProbeEndpoints(app);
}

function registerCryptoForecastingRoutes(app) {
  return cryptoForecastingEndpoints(app);
}

function registerCryptoRoutes(app) {
  registerCryptoCenterRoutes(app);
  registerCryptoHubRoutes(app);
  registerCryptoGateRoutes(app);
  registerCryptoForecastingRoutes(app);
}

module.exports = {
  registerCryptoCenterRoutes,
  registerCryptoHubRoutes,
  registerCryptoGateRoutes,
  registerCryptoForecastingRoutes,
  registerCryptoRoutes,
};
