const { User } = require("../models/user");
const { createModelRepository } = require("./createModelRepository");

const UserRepository = createModelRepository(User, {
  domain: "user",
  repositoryName: "UserRepository",
});

module.exports = { UserRepository };
