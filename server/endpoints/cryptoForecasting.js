const {
  registerCryptoForecastingRoutes,
} = require("../modules/crypto/httpAdapter");

function cryptoForecastingEndpoints(app) {
  return registerCryptoForecastingRoutes(app);
}

module.exports = {
  cryptoForecastingEndpoints,
};
