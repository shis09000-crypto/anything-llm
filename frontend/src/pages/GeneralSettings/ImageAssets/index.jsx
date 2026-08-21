import { useEffect, useMemo, useState } from "react";
import { Image, PushPin, ArrowClockwise, Trash } from "@phosphor-icons/react";
import Sidebar from "@/components/SettingsSidebar";
import PreLoader from "@/components/Preloader";
import ImageAsset from "@/models/imageAsset";
import { BLOB_KINDS, requestBlob } from "@/lib/communication/blobClient";
import showToast from "@/utils/toast";

function AssetPreview({ asset }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!asset?.previewUrl) return;
    const controller = new AbortController();
    let objectUrl = null;
    requestBlob(asset.previewUrl, {
      signal: controller.signal,
      blobKind: BLOB_KINDS.chatAttachment,
      communicationScene: "image-asset-preview",
    })
      .then(({ blob }) => {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => setUrl(null));
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset?.id, asset?.previewUrl]);
  return url ? (
    <img
      src={url}
      alt={asset.title || asset.displayName}
      className="w-full aspect-square object-cover rounded-xl"
    />
  ) : (
    <div className="w-full aspect-square rounded-xl bg-theme-bg-primary flex items-center justify-center">
      <Image className="w-10 h-10 text-theme-text-secondary" />
    </div>
  );
}

function sourceLabel(asset) {
  const source = asset.sources?.[0];
  if (!source) return "尚未关联会话";
  if (source.threadId) return `线程 #${source.threadId}`;
  return `对话 #${source.chatId}`;
}

export default function ImageAssetsPage() {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const result = await ImageAsset.list({
        status: "active",
        limit: 100,
        workspaceId: workspaceFilter || undefined,
      });
      setAssets(result?.items || []);
    } catch {
      showToast("图片资产读取失败，请稍后重试。", "error", { clear: true });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [workspaceFilter]);

  const workspaces = useMemo(
    () =>
      [
        ...new Set(assets.map((asset) => asset.workspaceId).filter(Boolean)),
      ].sort((a, b) => a - b),
    [assets]
  );

  async function mutate(asset, action) {
    setBusyId(asset.id);
    try {
      await action();
      await refresh();
    } catch (error) {
      showToast(error?.message || "操作失败，请稍后重试。", "error", {
        clear: true,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <main className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] light:border light:border-theme-sidebar-border bg-theme-bg-secondary w-full h-full overflow-y-auto p-4 md:p-0">
        <div className="flex flex-col w-full px-1 md:px-8 md:py-7 py-16">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-theme-sidebar-border">
            <div>
              <h1 className="text-xl font-semibold text-theme-text-primary">
                图片资产
              </h1>
              <p className="mt-1 text-sm text-theme-text-secondary">
                管理聊天中保存的原图、缩略图、模型同步状态与删除生命周期。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={workspaceFilter}
                onChange={(event) => setWorkspaceFilter(event.target.value)}
                className="h-10 rounded-lg border border-theme-sidebar-border bg-theme-bg-primary px-3 text-sm text-theme-text-primary"
              >
                <option value="">全部工作区</option>
                {workspaces.map((id) => (
                  <option key={id} value={id}>{`工作区 #${id}`}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void refresh()}
                className="h-10 px-3 rounded-lg border border-theme-sidebar-border text-theme-text-primary hover:bg-theme-bg-primary"
              >
                <ArrowClockwise className="w-4 h-4" />
              </button>
            </div>
          </div>

          {loading ? (
            <div className="h-[50vh] flex items-center justify-center">
              <PreLoader />
            </div>
          ) : assets.length === 0 ? (
            <div className="h-[45vh] flex flex-col items-center justify-center text-theme-text-secondary">
              <Image className="w-12 h-12 mb-3" />
              <p>还没有可管理的图片资产。</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 py-6">
              {assets.map((asset) => (
                <article
                  key={asset.id}
                  className="rounded-2xl border border-theme-sidebar-border bg-theme-bg-primary p-3"
                >
                  <AssetPreview asset={asset} />
                  <div className="pt-3 min-w-0">
                    <p className="font-medium text-theme-text-primary truncate">
                      {asset.title || asset.displayName}
                    </p>
                    <p className="text-xs text-theme-text-secondary mt-1">
                      {new Date(asset.createdAt).toLocaleString()} ·{" "}
                      {sourceLabel(asset)}
                    </p>
                    <p className="text-xs text-theme-text-secondary mt-1">
                      模型同步：{asset.providerSyncStatus || "pending"}
                    </p>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      type="button"
                      disabled={busyId === asset.id}
                      onClick={() =>
                        void mutate(asset, () =>
                          ImageAsset.update(asset.id, { pinned: !asset.pinned })
                        )
                      }
                      className="flex-1 h-9 rounded-lg border border-theme-sidebar-border text-theme-text-primary flex items-center justify-center gap-1 disabled:opacity-50"
                    >
                      <PushPin weight={asset.pinned ? "fill" : "regular"} />
                      {asset.pinned ? "取消固定" : "固定"}
                    </button>
                    {asset.providerSyncStatus !== "ready" && (
                      <button
                        type="button"
                        disabled={busyId === asset.id}
                        onClick={() =>
                          void mutate(asset, () => ImageAsset.sync(asset.id))
                        }
                        className="h-9 px-3 rounded-lg border border-theme-sidebar-border text-theme-text-primary disabled:opacity-50"
                        aria-label="重试同步"
                      >
                        <ArrowClockwise />
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyId === asset.id}
                      onClick={() => {
                        if (
                          !window.confirm(
                            "删除后，历史消息只保留不可恢复的占位。确认删除？"
                          )
                        )
                          return;
                        void mutate(asset, () => ImageAsset.delete(asset.id));
                      }}
                      className="h-9 px-3 rounded-lg bg-red-600 text-white disabled:opacity-50"
                      aria-label="删除图片资产"
                    >
                      <Trash />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
