const cors = require("cors");
const express = require("express");
const {
  communicationMetricsMiddleware,
} = require("../../middleware/communicationMetrics");
const {
  requestBodyLimitErrorHandler,
  requestBodyPolicy,
} = require("../../middleware/requestBodyPolicy");
const { clientIdentityMiddleware } = require("../clientIdentity");
const {
  observabilityContextMiddleware,
  operationContextBodyMiddleware,
} = require("../observability/context");
const { metricsEndpoint } = require("../observability/metrics");
const { setBrowserSecurityHeaders } = require("../security/browserHeaders");
const {
  applyTransportSecurity,
  corsOptionsForEnvironment,
} = require("../security/transportSecurity");
const { quarantineMiddleware } = require("../security/keyRuntimeState");
const { apiErrorMiddleware } = require("../http/apiError");

function registerCompatibleApi(app, registerRoutes) {
  app.use((_request, response, next) => {
    setBrowserSecurityHeaders(response);
    next();
  });
  applyTransportSecurity(app);
  app.use(observabilityContextMiddleware);
  app.use(communicationMetricsMiddleware);
  app.use(clientIdentityMiddleware);
  app.use(cors(corsOptionsForEnvironment()));
  app.use(requestBodyPolicy);
  app.use(operationContextBodyMiddleware);
  app.use(requestBodyLimitErrorHandler);
  app.get("/metrics", metricsEndpoint);

  const apiRouter = express.Router();
  apiRouter.use(quarantineMiddleware);
  registerRoutes(apiRouter);
  app.use("/api", apiRouter);
  app.use(apiErrorMiddleware);
  return apiRouter;
}

module.exports = { registerCompatibleApi };
