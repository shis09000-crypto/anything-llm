const { registerCryptoGateRoutes } = require("../modules/crypto/httpAdapter");

function cryptoGateProbeEndpoints(app) {
  return registerCryptoGateRoutes(app);
}

module.exports = {
  cryptoGateProbeEndpoints,
};
