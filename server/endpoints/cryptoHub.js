const { registerCryptoHubRoutes } = require("../modules/crypto/httpAdapter");

function cryptoHubEndpoints(app) {
  return registerCryptoHubRoutes(app);
}

module.exports = {
  cryptoHubEndpoints,
};
