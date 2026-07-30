const envPath =
  process.env.NODE_ENV === "development"
    ? `.env.${process.env.NODE_ENV}`
    : process.env.DESKTOP_ENV_PATH || ".env";
require("dotenv").config({ path: envPath });

const { applyEnvironmentStorage } = require("./utils/environment");
applyEnvironmentStorage();
process.env.ATHENA_RUNTIME_ROLE ||= "crypto-forecast";

const { startOpenTelemetry } = require("./utils/observability");
startOpenTelemetry();
require("./utils/logger")();

const {
  registerCryptoForecastingRoutes,
} = require("./modules/crypto/httpAdapter");
const { cryptoForecastingRuntime } = require("./utils/cryptoForecasting");
const {
  MicroModuleServiceHost,
  installStandaloneShutdown,
  registerCompatibleApi,
  secureDatabaseStart,
} = require("./utils/microModules");

const role = "crypto-forecast";
const host = new MicroModuleServiceHost({
  manifestId: "crypto-forecast",
  role,
  port: Number(process.env.CRYPTO_FORECAST_PORT || 3022),
  parseJson: false,
  readiness: () => cryptoForecastingRuntime.snapshot(),
  onStart: () =>
    secureDatabaseStart(role, () => cryptoForecastingRuntime.start()),
  onDrain: () => cryptoForecastingRuntime.stop(),
  registerRoutes: (app) => {
    registerCompatibleApi(app, registerCryptoForecastingRoutes);
    app.get("/internal/v1/crypto/forecast", (request, response) => {
      response.json({
        success: true,
        result: cryptoForecastingRuntime.latest(request.query?.symbol),
      });
    });
  },
});

installStandaloneShutdown(host, { name: "CryptoForecast" });
host
  .start()
  .then((snapshot) =>
    console.log(`[CryptoForecast] listening on ${host.port}`, snapshot)
  )
  .catch((error) => {
    console.error("[CryptoForecast] failed to start", error);
    process.exitCode = 1;
  });
