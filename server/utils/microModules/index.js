const {
  requestInternalService,
  requestInternalStream,
} = require("./internalClient");
const {
  MicroModuleServiceHost,
  distributedTopology,
  internalPeerAuthorized,
  peerServiceIds,
} = require("./serviceHost");
const { registerCompatibleApi } = require("./runtimeApp");
const {
  installStandaloneShutdown,
  secureDatabaseStart,
} = require("./standalone");

module.exports = {
  MicroModuleServiceHost,
  distributedTopology,
  internalPeerAuthorized,
  installStandaloneShutdown,
  peerServiceIds,
  registerCompatibleApi,
  requestInternalService,
  requestInternalStream,
  secureDatabaseStart,
};
