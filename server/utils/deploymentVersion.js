/**
 * Returns the deployment version.
 * - Dev: reads from package.json
 * - Prod: reads from ENV
 * expected format: major.minor.patch
 * @returns {string|null} The deployment version.
 */
function getDeploymentVersion(env = process.env) {
  if (env.NODE_ENV === "development")
    return require("../../package.json").version;
  if (env.DEPLOYMENT_VERSION) return env.DEPLOYMENT_VERSION;
  return null;
}

module.exports = {
  getDeploymentVersion,
};
