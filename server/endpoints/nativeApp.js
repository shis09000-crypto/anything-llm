const {
  appleAppSiteAssociation,
  buildNativeAppBootstrap,
  buildNativeAppPreflight,
} = require("../utils/nativeAppBootstrap");
const { opaqueNativeConfiguration } = require("./authZkLogin");

function noStore(response) {
  response.setHeader("Cache-Control", "no-store");
}

function nativeAppPublicEndpoints(app) {
  if (!app) return;

  const appleAssociationHandler = async (_request, response) => {
    try {
      const association = appleAppSiteAssociation();
      if (!association.configured) {
        return response.status(404).json({
          success: false,
          error: "ios_associated_domain_not_configured",
        });
      }

      noStore(response);
      response.setHeader("Content-Type", "application/json");
      return response.status(200).json(association.payload);
    } catch (error) {
      console.error("[native-app] AASA failed", error.message);
      return response.status(error.httpStatus || 500).json({
        success: false,
        error: "apple_app_site_association_failed",
      });
    }
  };

  app.get("/.well-known/apple-app-site-association", appleAssociationHandler);
  app.get("/apple-app-site-association", appleAssociationHandler);
}

function nativeAppEndpoints(app) {
  if (!app) return;

  app.get("/native-app/bootstrap", async (_request, response) => {
    try {
      noStore(response);
      const bootstrap = buildNativeAppBootstrap();
      bootstrap.security ||= {};
      bootstrap.security.opaque = await opaqueNativeConfiguration();
      return response.status(200).json(bootstrap);
    } catch (error) {
      console.error("[native-app] bootstrap failed", error.message);
      return response.status(error.httpStatus || 500).json({
        success: false,
        error: "native_app_bootstrap_failed",
      });
    }
  });

  app.get("/native-app/preflight", async (request, response) => {
    try {
      noStore(response);
      return response.status(200).json(
        buildNativeAppPreflight({
          query: request.query || {},
          headers: request.headers || {},
        })
      );
    } catch (error) {
      console.error("[native-app] preflight failed", error.message);
      return response.status(error.httpStatus || 500).json({
        success: false,
        error: "native_app_preflight_failed",
      });
    }
  });
}

module.exports = { nativeAppEndpoints, nativeAppPublicEndpoints };
