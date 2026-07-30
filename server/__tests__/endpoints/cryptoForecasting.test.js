/* eslint-env jest */

const {
  cryptoForecastingEndpoints,
} = require("../../modules/crypto/httpForecastingHandlers");
const { CryptoRuntime } = require("../../modules/crypto");

function responseDouble() {
  const response = {
    status: jest.fn(() => response),
    json: jest.fn(() => response),
  };
  return response;
}

describe("crypto forecasting endpoints", () => {
  it("registers read-only prediction routes and admin governance", () => {
    const routes = [];
    const app = { get: (...args) => routes.push(args) };
    cryptoForecastingEndpoints(app);
    expect(routes.map(([route]) => route)).toEqual([
      "/crypto-forecasting/latest",
      "/crypto-forecasting/predictions",
      "/crypto-forecasting/predictions/:predictionId",
      "/crypto-forecasting/governance",
    ]);
    for (const [, guards, handler] of routes) {
      expect(guards).toHaveLength(2);
      expect(typeof handler).toBe("function");
    }
  });

  it("limits history pages and returns 404 for unknown passports", () => {
    const routes = [];
    cryptoForecastingEndpoints({ get: (...args) => routes.push(args) });
    const history = routes.find(
      ([route]) => route === "/crypto-forecasting/predictions"
    );
    const invalidLimitResponse = responseDouble();
    history.at(-1)(
      { query: { limit: "101" } },
      invalidLimitResponse
    );
    expect(invalidLimitResponse.status).toHaveBeenCalledWith(400);
    expect(invalidLimitResponse.json).toHaveBeenCalledWith({
      success: false,
      error: "invalid_limit",
    });

    jest
      .spyOn(CryptoRuntime.forecasting, "predictionDetails")
      .mockReturnValueOnce(null);
    const detail = routes.find(
      ([route]) =>
        route === "/crypto-forecasting/predictions/:predictionId"
    );
    const missingResponse = responseDouble();
    detail.at(-1)(
      { params: { predictionId: "missing" } },
      missingResponse
    );
    expect(missingResponse.status).toHaveBeenCalledWith(404);
  });
});
