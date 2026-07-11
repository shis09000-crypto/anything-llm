const mockBuildNativeAppBootstrap = jest.fn(() => ({
  success: true,
  protocolVersion: "ios-native-v1",
}));
const mockBuildNativeAppPreflight = jest.fn(() => ({
  success: true,
  compatible: true,
}));
const mockAppleAppSiteAssociation = jest.fn(() => ({
  configured: true,
  payload: { applinks: { apps: [], details: [] } },
}));

jest.mock("../../utils/nativeAppBootstrap", () => ({
  appleAppSiteAssociation: (...args) => mockAppleAppSiteAssociation(...args),
  buildNativeAppBootstrap: (...args) => mockBuildNativeAppBootstrap(...args),
  buildNativeAppPreflight: (...args) => mockBuildNativeAppPreflight(...args),
}));

const {
  nativeAppEndpoints,
  nativeAppPublicEndpoints,
} = require("../../endpoints/nativeApp");

function appDouble() {
  const routes = [];
  return {
    routes,
    get: jest.fn((path, ...handlers) => {
      routes.push({ method: "get", path, handlers });
    }),
  };
}

function responseDouble() {
  const response = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  return response;
}

describe("native app bootstrap endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("registers a public bootstrap route without validatedRequest middleware", async () => {
    const app = appDouble();
    nativeAppEndpoints(app);

    const route = app.routes.find(
      (item) => item.path === "/native-app/bootstrap"
    );
    expect(route).toMatchObject({
      method: "get",
      path: "/native-app/bootstrap",
    });
    expect(route.handlers).toHaveLength(1);

    const response = responseDouble();
    await route.handlers[0]({}, response);

    expect(mockBuildNativeAppBootstrap).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "no-store"
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      protocolVersion: "ios-native-v1",
    });
  });

  it("does not register or alter legacy mobile routes", () => {
    const app = appDouble();
    nativeAppEndpoints(app);

    expect(app.routes.map((route) => route.path)).toEqual([
      "/native-app/bootstrap",
      "/native-app/preflight",
    ]);
    expect(
      app.routes.some((route) => String(route.path).startsWith("/mobile"))
    ).toBe(false);
  });

  it("registers a public preflight route", async () => {
    const app = appDouble();
    nativeAppEndpoints(app);
    const route = app.routes.find(
      (item) => item.path === "/native-app/preflight"
    );
    const response = responseDouble();
    await route.handlers[0](
      {
        query: { appVersion: "1.0.0", osVersion: "26.0" },
        headers: { "x-athena-platform": "ios" },
      },
      response
    );

    expect(mockBuildNativeAppPreflight).toHaveBeenCalledWith({
      query: { appVersion: "1.0.0", osVersion: "26.0" },
      headers: { "x-athena-platform": "ios" },
    });
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "no-store"
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      success: true,
      compatible: true,
    });
  });

  it("serves the Apple app site association file from public root paths", async () => {
    const app = appDouble();
    nativeAppPublicEndpoints(app);
    const response = responseDouble();

    expect(app.routes.map((route) => route.path)).toEqual([
      "/.well-known/apple-app-site-association",
      "/apple-app-site-association",
    ]);

    await app.routes[0].handlers[0]({}, response);
    expect(mockAppleAppSiteAssociation).toHaveBeenCalledTimes(1);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "no-store"
    );
    expect(response.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json"
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      applinks: { apps: [], details: [] },
    });
  });
});
