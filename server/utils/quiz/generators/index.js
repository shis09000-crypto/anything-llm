const { singleChoiceGenerator } = require("./singleChoiceGenerator");
const { multipleChoiceGenerator } = require("./multipleChoiceGenerator");
const { fillBlankGenerator } = require("./fillBlankGenerator");

const generatorByName = {
  singleChoiceGenerator,
  multipleChoiceGenerator,
  fillBlankGenerator,
};

async function runGenerationJob(job) {
  const generator = generatorByName[job.generator];
  if (!generator) throw new Error(`Unknown quiz generator: ${job.generator}`);
  return await generator(job);
}

module.exports = {
  runGenerationJob,
  singleChoiceGenerator,
  multipleChoiceGenerator,
  fillBlankGenerator,
};
