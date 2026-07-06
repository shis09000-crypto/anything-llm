const prisma = require("../utils/prisma");

const ClientIdentityRepository = {
  dataDomain: "client-identity",
  repositoryName: "ClientIdentityRepository",

  get db() {
    return {
      get athena_clients() {
        return prisma.athena_clients;
      },
    };
  },
};

module.exports = { ClientIdentityRepository };
