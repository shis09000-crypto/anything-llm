const prisma = require("../utils/prisma");

const RequestSigningRepository = {
  dataDomain: "request-signing",
  repositoryName: "RequestSigningRepository",

  get db() {
    return {
      get athena_clients() {
        return prisma.athena_clients;
      },
      get athena_request_nonces() {
        return prisma.athena_request_nonces;
      },
      get vault_device_key_registrations() {
        return prisma.vault_device_key_registrations;
      },
      $transaction(callback, options) {
        return prisma.$transaction(callback, options);
      },
    };
  },
};

module.exports = { RequestSigningRepository };
