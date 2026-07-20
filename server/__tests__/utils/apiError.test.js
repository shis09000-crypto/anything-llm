const {
  apiErrorCode,
  apiErrorMiddleware,
  apiErrorStatus,
} = require("../../utils/http/apiError");
const {
  ModelDataAccessError,
} = require("../../utils/dataAccess/modelErrors");

describe("API error mapping", () => {
  it("maps model data failures to a stable 503 response", () => {
    const error = new ModelDataAccessError("Workspace.where", new Error("db"));
    expect(error.message).toBe("database_operation_failed");
    expect(apiErrorStatus(error)).toBe(503);
    expect(apiErrorCode(error)).toBe("database_operation_failed");

    const response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    apiErrorMiddleware(error, {}, response, jest.fn());
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "database_operation_failed",
    });
  });

  it("does not trust an invalid status code", () => {
    expect(apiErrorStatus({ httpStatus: 200 })).toBe(500);
    expect(apiErrorCode({})).toBe("internal_server_error");
  });
});
