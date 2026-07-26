const prisma = require("../utils/prisma");

const ClientIdentityRepository = {
  dataDomain: "client-identity",
  repositoryName: "ClientIdentityRepository",

  get db() {
    return {
      get athena_clients() {
        return prisma.athena_clients;
      },
      get athena_device_attestation_challenges() {
        return prisma.athena_device_attestation_challenges;
      },
      get users() {
        return prisma.users;
      },
      $transaction(callback, options) {
        return prisma.$transaction(callback, options);
      },
    };
  },
};

module.exports = { ClientIdentityRepository };
