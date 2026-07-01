const { EventLogs } = require("../models/eventLogs");
const { VaultItem } = require("../models/vaultItem");
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");

function currentUserId(response) {
  const id = Number(response?.locals?.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function vaultErrorResponse(response, error) {
  const message = String(error?.message || error || "vault_error");
  const status = message.includes("required")
    ? 400
    : message.includes("too_large")
      ? 413
      : 500;
  return response.status(status).json({ success: false, error: message });
}

function vaultEndpoints(app) {
  if (!app) return;

  app.get("/vault/items", [validatedRequest], async (request, response) => {
    const userId = currentUserId(response);
    if (!userId) {
      return response.status(401).json({ success: false, error: "unauthorized" });
    }

    const items = await VaultItem.list({
      userId,
      itemType: request.query?.type || null,
    });
    return response.status(200).json({ success: true, items });
  });

  app.get("/vault/items/:itemId", [validatedRequest], async (request, response) => {
    const userId = currentUserId(response);
    if (!userId) {
      return response.status(401).json({ success: false, error: "unauthorized" });
    }

    const item = await VaultItem.get({
      userId,
      itemId: request.params.itemId,
      includeEncryptedPayload: true,
    });
    if (!item) {
      return response
        .status(404)
        .json({ success: false, error: "vault_item_not_found" });
    }
    void EventLogs.logEvent(
      "vault_item_read",
      {
        itemId: item.itemId,
        itemType: item.itemType,
        cryptoVersion: item.cryptoVersion,
      },
      userId
    );
    return response.status(200).json({ success: true, item });
  });

  app.post("/vault/items", [validatedRequest], async (request, response) => {
    const userId = currentUserId(response);
    if (!userId) {
      return response.status(401).json({ success: false, error: "unauthorized" });
    }

    try {
      const body = reqBody(request);
      const item = await VaultItem.createOrUpdate({
        userId,
        itemId: body.itemId || body.id || null,
        itemType: body.itemType || body.type || "secret",
        label: body.label || null,
        encryptedPayload: body.encryptedPayload,
        keyId: body.keyId || null,
        cryptoVersion: body.cryptoVersion || null,
        metadata: body.metadata || {},
      });

      void EventLogs.logEvent(
        "vault_item_saved",
        {
          itemId: item.itemId,
          itemType: item.itemType,
          cryptoVersion: item.cryptoVersion,
        },
        userId
      );
      return response.status(200).json({ success: true, item });
    } catch (error) {
      return vaultErrorResponse(response, error);
    }
  });

  app.delete(
    "/vault/items/:itemId",
    [validatedRequest],
    async (request, response) => {
      const userId = currentUserId(response);
      if (!userId) {
        return response
          .status(401)
          .json({ success: false, error: "unauthorized" });
      }

      const deleted = await VaultItem.delete({
        userId,
        itemId: request.params.itemId,
      });
      if (!deleted) {
        return response
          .status(404)
          .json({ success: false, error: "vault_item_not_found" });
      }

      void EventLogs.logEvent(
        "vault_item_deleted",
        { itemId: request.params.itemId },
        userId
      );
      return response.status(200).json({ success: true, deleted: true });
    }
  );
}

module.exports = { vaultEndpoints };
