const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const bodyParser = require("body-parser");
const cors = require("cors");
const express = require("express");

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();

const { ensureWebCrypto } = require("./utils/security/webCrypto");
ensureWebCrypto();

const {
  assertProductionSecurityConfig,
} = require("./utils/security/startupValidation");
assertProductionSecurityConfig();

const {
  applyTransportSecurity,
  corsOptionsForEnvironment,
} = require("./utils/security/transportSecurity");
const {
  setBrowserSecurityHeaders,
} = require("./utils/security/browserHeaders");
const { clientIdentityMiddleware } = require("./utils/clientIdentity");
const { syncCenterEndpoints } = require("./endpoints/syncCenter");
const { RealtimeGatewayRuntime } = require("./utils/realtimeGateway/runtime");

const FILE_LIMIT = "3MB";
const app = express();
const runtime = new RealtimeGatewayRuntime();

function rawBodySaver(request, _response, buffer) {
  if (buffer?.length) request.rawBody = buffer.toString("utf8");
}

require("@mintplex-labs/express-ws").default(app);

app.use((_request, response, next) => {
  setBrowserSecurityHeaders(response);
  next();
});
applyTransportSecurity(app);
app.use(clientIdentityMiddleware);
app.use(cors(corsOptionsForEnvironment()));
app.use(bodyParser.text({ limit: FILE_LIMIT, verify: rawBodySaver }));
app.use(bodyParser.json({ limit: FILE_LIMIT, verify: rawBodySaver }));
app.use(
  bodyParser.urlencoded({
    limit: FILE_LIMIT,
    extended: true,
    verify: rawBodySaver,
  })
);

const apiRouter = express.Router();
app.use("/api", apiRouter);
syncCenterEndpoints(apiRouter);

app.get("/health", (_request, response) => {
  response.status(runtime.status === "failed" ? 503 : 200).json({
    success: runtime.status !== "failed",
    role: "realtime-gateway",
  });
});

app.get("/snapshot", (_request, response) => {
  response.status(200).json(runtime.snapshot());
});

const port = Number(process.env.REALTIME_GATEWAY_PORT || 3013);
try {
  runtime.start();
  app.listen(port, () => {
    console.log(`[RealtimeGateway] listening on ${port}`);
  });
} catch (error) {
  runtime.fail(error);
  console.error("[RealtimeGateway] failed to start", error);
  process.exitCode = 1;
}
