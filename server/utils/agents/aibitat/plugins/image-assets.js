const { DataAccessCenter } = require("../../../dataAccess");
const {
  assetForOwner,
  imageAssetOwner,
  publicAsset,
} = require("../../../imageAssets/service");

const LOAD_IMAGE_TOOL = "load_image";
const SEARCH_IMAGE_ASSETS_TOOL = "search_image_assets";

const imageAssets = {
  name: "image-assets",
  startupConfig: { params: {} },
  plugin() {
    return {
      name: this.name,
      setup(aibitat) {
        aibitat.function({
          super: aibitat,
          name: LOAD_IMAGE_TOOL,
          description:
            "Load one user-owned persistent image asset into the current Responses turn when visual inspection is required. Use the exact asset_id from available_image_assets or search_image_assets.",
          parameters: {
            type: "object",
            properties: {
              asset_id: {
                type: "string",
                description: "Internal image asset UUID.",
              },
            },
            required: ["asset_id"],
            additionalProperties: false,
          },
          handler: async function ({ asset_id } = {}) {
            const invocation = this.super.handlerProps?.invocation || {};
            const asset = await assetForOwner({
              assetId: asset_id,
              workspaceId: invocation.workspace_id || invocation.workspace?.id,
              userId: invocation.user_id || null,
            });
            if (!asset)
              return JSON.stringify({
                ok: false,
                error: "image_asset_not_found",
              });
            this.super.addToolAttachment({
              kind: "persistent",
              assetId: asset.id,
              imageAssetId: asset.id,
              name: asset.displayName,
              mimeType: asset.mimeType,
              byteSize: asset.byteSize,
              detail: "original",
            });
            return JSON.stringify({
              ok: true,
              asset_id: asset.id,
              title: asset.title || asset.displayName,
              summary: asset.summary || null,
              instruction:
                "The original image is attached to this tool result.",
            });
          },
        });

        aibitat.function({
          super: aibitat,
          name: SEARCH_IMAGE_ASSETS_TOOL,
          description:
            "Search the current user's persistent image asset index by filename, title, summary, or tag. Returns metadata only; call load_image to inspect one candidate.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Short image search query.",
              },
              limit: { type: "integer", minimum: 1, maximum: 12 },
            },
            required: ["query"],
            additionalProperties: false,
          },
          handler: async function ({ query = "", limit = 8 } = {}) {
            const invocation = this.super.handlerProps?.invocation || {};
            const workspaceId =
              invocation.workspace_id || invocation.workspace?.id;
            const owner = imageAssetOwner({
              userId: invocation.user_id || null,
              workspaceId,
            });
            const rows = await DataAccessCenter.imageAsset.search({
              ...owner,
              workspaceId,
              query,
              limit,
            });
            return JSON.stringify({
              ok: true,
              assets: rows.map((row) => {
                const asset = publicAsset(row);
                return {
                  asset_id: asset.id,
                  title: asset.title || asset.displayName,
                  summary: asset.summary || null,
                  tags: asset.tags || [],
                  pinned: Boolean(asset.pinned),
                  created_at: asset.createdAt,
                };
              }),
            });
          },
        });
      },
    };
  },
};

module.exports = {
  LOAD_IMAGE_TOOL,
  SEARCH_IMAGE_ASSETS_TOOL,
  imageAssets,
};
