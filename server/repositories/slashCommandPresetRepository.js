const { SlashCommandPresets } = require("../models/slashCommandsPresets");
const { createModelRepository } = require("./createModelRepository");

const SlashCommandPresetRepository = createModelRepository(
  SlashCommandPresets,
  {
    domain: "slash-command-preset",
    repositoryName: "SlashCommandPresetRepository",
  }
);

module.exports = { SlashCommandPresetRepository };
