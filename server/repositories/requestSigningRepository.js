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
    };
  },
};

module.exports = { RequestSigningRepository };
