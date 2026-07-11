const { AthenaMutationReceipt } = require("../models/athenaMutationReceipt");
const { createModelRepository } = require("./createModelRepository");

const AthenaMutationReceiptRepository = createModelRepository(
  AthenaMutationReceipt,
  {
    domain: "athena-mutation-receipt",
    repositoryName: "AthenaMutationReceiptRepository",
  }
);

module.exports = { AthenaMutationReceiptRepository };
