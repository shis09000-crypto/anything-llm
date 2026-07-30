const { CryptoRuntime } = require("./runtime");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");

function failureStatus(error) {
  if (
    ["unsupported_symbol", "unsupported_horizon", "invalid_cursor"].includes(
      error?.code
    )
  )
    return 400;
  return 500;
}

function sendFailure(response, error) {
  return response.status(failureStatus(error)).json({
    success: false,
    error: error?.code || "crypto_forecasting_unavailable",
  });
}

function cryptoForecastingEndpoints(app) {
  if (!app) return;
  const ordinaryAccess = [validatedRequest, flexUserRoleValid([ROLES.all])];
  const governanceAccess = [validatedRequest, flexUserRoleValid([ROLES.admin])];

  app.get("/crypto-forecasting/latest", ordinaryAccess, (request, response) => {
    try {
      return response
        .status(200)
        .json(CryptoRuntime.forecasting.latest(request.query?.symbol));
    } catch (error) {
      return sendFailure(response, error);
    }
  });

  app.get(
    "/crypto-forecasting/predictions",
    ordinaryAccess,
    (request, response) => {
      try {
        const requestedLimit = Number(request.query?.limit ?? 50);
        if (
          !Number.isInteger(requestedLimit) ||
          requestedLimit < 1 ||
          requestedLimit > 100
        )
          return response.status(400).json({
            success: false,
            error: "invalid_limit",
          });
        return response.status(200).json(
          CryptoRuntime.forecasting.predictions({
            symbol: request.query?.symbol || null,
            horizon: request.query?.horizon || null,
            before: request.query?.before || null,
            limit: requestedLimit,
          })
        );
      } catch (error) {
        return sendFailure(response, error);
      }
    }
  );

  app.get(
    "/crypto-forecasting/predictions/:predictionId",
    ordinaryAccess,
    (request, response) => {
      try {
        const result = CryptoRuntime.forecasting.predictionDetails(
          request.params.predictionId
        );
        if (!result)
          return response.status(404).json({
            success: false,
            error: "prediction_not_found",
          });
        return response.status(200).json(result);
      } catch (error) {
        return sendFailure(response, error);
      }
    }
  );

  app.get(
    "/crypto-forecasting/governance",
    governanceAccess,
    (_request, response) => {
      try {
        return response
          .status(200)
          .json(CryptoRuntime.forecasting.governance());
      } catch (error) {
        return sendFailure(response, error);
      }
    }
  );
}

module.exports = {
  cryptoForecastingEndpoints,
};
