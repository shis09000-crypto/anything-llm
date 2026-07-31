const contracts = require("./contracts");
const destinationGuard = require("./destinationGuard");
const policy = require("./policy");

module.exports = {
  ...contracts,
  ...destinationGuard,
  ...policy,
};
