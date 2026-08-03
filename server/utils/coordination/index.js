const autonomyPolicy = require("./autonomyPolicy");
const centers = require("./centers");
const runtime = require("./runtime");

module.exports = {
  ...autonomyPolicy,
  ...centers,
  ...runtime,
};
