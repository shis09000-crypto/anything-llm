const { registerCryptoCenterRoutes } = require("../modules/crypto/httpAdapter");

function cryptoCenterEndpoints(app) {
  return registerCryptoCenterRoutes(app);
}

module.exports = {
  cryptoCenterEndpoints,
};
