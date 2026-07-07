const { ScheduledJob } = require("../models/scheduledJob");
const { ScheduledJobRun } = require("../models/scheduledJobRun");

const ScheduledJobRepository = {
  dataDomain: "scheduled-job",
  repositoryName: "ScheduledJobRepository",

  get job() {
    return ScheduledJob;
  },

  get run() {
    return ScheduledJobRun;
  },
};

module.exports = { ScheduledJobRepository };
