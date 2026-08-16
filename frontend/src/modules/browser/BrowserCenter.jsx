import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  BookmarkSimple,
  CaretDown,
  Cookie,
  Desktop,
  GlobeHemisphereWest,
  House,
  Keyboard,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SidebarSimple,
  Star,
  X,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import BrowserPlane from "@/models/browserPlane";
import paths from "@/utils/paths";
import useUser from "@/hooks/useUser";
import { ACCOUNT_ROLES, roleMatches } from "@/utils/authz";

const CLOUD_FALLBACK_FRAME_INTERVAL_MS = 1_500;
const DEFAULT_URL = "https://www.google.com/";

function desktopNode() {
  return typeof window !== "undefined"
    ? window.athenaBrowserNode || null
    : null;
}

function navigationTarget(value) {
  const input = String(value || "").trim();
  if (!input) return DEFAULT_URL;
  try {
    const candidate = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const url = new URL(candidate);
    if (input.includes(".") && !/\s/.test(input)) return url.toString();
  } catch {}
  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

function displayUrl(value) {
  if (!value || value === "about:blank") return "";
  return value;
}

function downloadBase64({ data, mimeType, filename }) {
  if (!data) return;
  const anchor = document.createElement("a");
  anchor.href = `data:${mimeType};base64,${data}`;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
}

function ToolbarButton({
  label,
  children,
  onClick,
  disabled = false,
  active = false,
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition disabled:opacity-30 ${
        active
          ? "bg-cyan-400/15 text-cyan-300 light:text-cyan-700"
          : "text-theme-text-secondary hover:bg-white/10 hover:text-theme-text-primary light:hover:bg-slate-100"
      }`}
    >
      {children}
    </button>
  );
}

function CookiePanel({
  sites,
  permissions = null,
  onClose,
  onClear,
  onPermission,
}) {
  return (
    <aside className="absolute right-4 top-[112px] z-40 flex max-h-[calc(100%-132px)] w-[min(420px,calc(100%-32px))] flex-col overflow-hidden rounded-2xl border border-white/10 bg-theme-bg-secondary/95 shadow-2xl backdrop-blur-xl light:border-slate-200 light:bg-white/95">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 light:border-slate-200">
        <div>
          <div className="text-sm font-semibold text-theme-text-primary">
            站点数据
          </div>
          <div className="mt-1 text-xs text-theme-text-secondary">
            只显示属性摘要，Cookie值永不展示或导出
          </div>
        </div>
        <ToolbarButton label="关闭" onClick={onClose}>
          <X className="h-4 w-4" />
        </ToolbarButton>
      </div>
      <div className="overflow-y-auto p-3">
        {permissions?.origin ? (
          <div className="mb-3 rounded-xl border border-white/10 p-3 light:border-slate-200">
            <div className="truncate text-sm font-medium text-theme-text-primary">
              {permissions.origin}
            </div>
            <div className="mt-2 space-y-2">
              {permissions.permissions.map((permission) => (
                <label
                  key={permission.name}
                  className="flex items-center justify-between gap-3 text-xs text-theme-text-secondary"
                >
                  <span>
                    {{
                      media: "摄像头与麦克风",
                      notifications: "通知",
                      geolocation: "位置",
                    }[permission.name] || permission.name}
                  </span>
                  <input
                    type="checkbox"
                    checked={permission.allowed}
                    onChange={(event) =>
                      onPermission?.(permission.name, event.target.checked)
                    }
                  />
                </label>
              ))}
            </div>
          </div>
        ) : null}
        {sites.length ? (
          sites.map((site) => (
            <div
              key={site.domain}
              className="mb-2 rounded-xl border border-white/10 p-3 light:border-slate-200"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-theme-text-primary">
                    {site.domain}
                  </div>
                  <div className="text-xs text-theme-text-secondary">
                    {site.count} 个Cookie
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onClear(site.domain)}
                  className="rounded-lg border border-red-400/30 px-2.5 py-1 text-xs text-red-300 hover:bg-red-400/10 light:text-red-600"
                >
                  清除站点数据
                </button>
              </div>
              <div className="mt-2 space-y-1">
                {site.cookies.slice(0, 8).map((cookie) => (
                  <div
                    key={`${site.domain}:${cookie.name}`}
                    className="flex items-center justify-between gap-2 text-[11px] text-theme-text-secondary"
                  >
                    <span className="truncate">{cookie.name}</span>
                    <span className="shrink-0">
                      {[
                        cookie.sameSite,
                        cookie.secure ? "Secure" : null,
                        cookie.httpOnly ? "HttpOnly" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "普通"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="p-6 text-center text-sm text-theme-text-secondary">
            当前Profile没有可显示的站点Cookie
          </div>
        )}
      </div>
    </aside>
  );
}

export default function BrowserCenter() {
  const navigate = useNavigate();
  const { user } = useUser();
  const viewportRef = useRef(null);
  const captureRunning = useRef(false);
  const streamSocket = useRef(null);
  const streamViewport = useRef({ width: 1365, height: 768 });
  const streamConnected = useRef(false);
  const touchPoint = useRef(null);
  const lastTouchSentAt = useRef(0);
  const suppressNextClick = useRef(false);
  const mounted = useRef(true);
  const [location, setLocation] = useState(desktopNode() ? "desktop" : "cloud");
  const [session, setSession] = useState(null);
  const [address, setAddress] = useState("");
  const [frame, setFrame] = useState(null);
  const [status, setStatus] = useState("正在准备浏览器…");
  const [error, setError] = useState(null);
  const [cookieOpen, setCookieOpen] = useState(false);
  const [cookieSites, setCookieSites] = useState([]);
  const [sitePermissions, setSitePermissions] = useState(null);
  const [sidePanel, setSidePanel] = useState(null);
  const [history, setHistory] = useState([]);
  const [bookmarks, setBookmarks] = useState([]);
  const [desktopState, setDesktopState] = useState(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findTerm, setFindTerm] = useState("");
  const [findCount, setFindCount] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [cloudTextOpen, setCloudTextOpen] = useState(false);
  const [cloudText, setCloudText] = useState("");
  const [networkRoute, setNetworkRoute] = useState("system");
  const [networkState, setNetworkState] = useState(null);
  const [routeBusy, setRouteBusy] = useState(false);
  const [egressStatus, setEgressStatus] = useState(null);

  const canManageEgress = roleMatches(user, [
    ACCOUNT_ROLES.owner,
    ACCOUNT_ROLES.admin,
  ]);

  const currentTab = useMemo(() => {
    const tabs = location === "desktop" ? desktopState?.tabs : session?.tabs;
    const currentId =
      location === "desktop"
        ? desktopState?.currentTabId
        : session?.currentTabId;
    return tabs?.find((tab) => tab.tabId === currentId) || tabs?.[0] || null;
  }, [desktopState, location, session]);

  const refreshDesktopBounds = useCallback(() => {
    const node = desktopNode();
    const element = viewportRef.current;
    if (!node || !element || location !== "desktop") return;
    const rect = element.getBoundingClientRect();
    void node.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
  }, [location]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const node = desktopNode();
    if (!node) return;
    const nodeId = node.nodeId();
    const heartbeat = () =>
      BrowserPlane.heartbeatNode({
        nodeId,
        version: node.version(),
        capabilities: node.capabilities(),
      }).catch(() => null);
    void heartbeat();
    const timer = window.setInterval(heartbeat, 20_000);
    const dispose = node.onState(
      (next) => mounted.current && setDesktopState(next)
    );
    return () => {
      window.clearInterval(timer);
      dispose?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSession(null);
    setFrame(null);
    setError(null);
    setStatus(
      location === "desktop" ? "正在连接本机浏览器节点…" : "正在启动云端浏览器…"
    );
    const start = async () => {
      if (location === "desktop") {
        const node = desktopNode();
        if (!node)
          throw new Error("当前不是Athena桌面端，无法使用本机浏览器节点。");
        const controlSession = await BrowserPlane.createSession({
          location: "desktop",
          profileId: "default",
        });
        const route = canManageEgress
          ? await BrowserPlane.profileRoute("default").catch(() => null)
          : null;
        const selectedRoute =
          route?.networkRoute ||
          controlSession?.profile?.networkRoute ||
          "system";
        const next = await node.attach({
          accountRef: String(user?.id || user?.username || "local-account"),
          profileId: "default",
          networkRoute: selectedRoute,
        });
        if (cancelled) return;
        setSession(controlSession);
        setDesktopState(next);
        setNetworkRoute(selectedRoute);
        setNetworkState(next?.network || route?.network || null);
        setStatus(
          selectedRoute === "athena_egress"
            ? "本机 · WebContentsView · Athena海外出口"
            : selectedRoute === "direct"
              ? "本机 · WebContentsView · 本地直连"
              : "本机 · WebContentsView · 系统代理"
        );
        if (canManageEgress)
          void BrowserPlane.egressStatus()
            .then((value) => mounted.current && setEgressStatus(value))
            .catch(() => null);
        requestAnimationFrame(refreshDesktopBounds);
        return;
      }
      desktopNode()?.detach?.();
      const next = await BrowserPlane.createSession({
        location: "cloud",
        profileId: "default",
        viewport: { width: 1365, height: 768 },
      });
      if (cancelled) return;
      setSession(next);
      setStatus("云端 · Playwright Chromium");
    };
    void start().catch((cause) => {
      if (!cancelled) {
        setError(cause?.message || "浏览器会话启动失败");
        setStatus("浏览器不可用");
      }
    });
    return () => {
      cancelled = true;
      if (location === "desktop") desktopNode()?.detach?.();
    };
  }, [
    canManageEgress,
    location,
    refreshDesktopBounds,
    user?.id,
    user?.username,
  ]);

  useEffect(() => {
    if (location !== "desktop" || !viewportRef.current) return;
    const observer = new ResizeObserver(refreshDesktopBounds);
    observer.observe(viewportRef.current);
    window.addEventListener("resize", refreshDesktopBounds);
    window.addEventListener("scroll", refreshDesktopBounds, true);
    refreshDesktopBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refreshDesktopBounds);
      window.removeEventListener("scroll", refreshDesktopBounds, true);
    };
  }, [location, refreshDesktopBounds]);

  const cloudAction = useCallback(
    async (action, args = {}, options = {}) => {
      if (!session?.id) return null;
      const result = await BrowserPlane.action(session.id, {
        tabId: options.tabId || currentTab?.tabId,
        action,
        arguments: args,
      });
      if (!mounted.current) return result;
      if (result?.observation?.url) {
        setAddress(displayUrl(result.observation.url));
        setSession((current) => ({
          ...current,
          currentTabId: result.tabId || current?.currentTabId,
          tabs: (current?.tabs || []).map((tab) =>
            tab.tabId === (result.tabId || current?.currentTabId)
              ? {
                  ...tab,
                  url: result.observation.url,
                  title: result.observation.title,
                }
              : tab
          ),
        }));
      }
      return result;
    },
    [currentTab?.tabId, session?.id]
  );

  useEffect(() => {
    if (location !== "cloud" || !session?.id) return;
    let disposed = false;
    const heartbeat = async () => {
      try {
        const next = await BrowserPlane.session(session.id);
        if (!disposed && next) setSession(next);
      } catch (cause) {
        if (!disposed) setError(cause?.message || "云端浏览器心跳失败");
      }
    };
    const timer = window.setInterval(heartbeat, 30_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [location, session?.id]);

  useEffect(() => {
    if (location !== "cloud" || !session?.id) return;
    let disposed = false;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    const connect = async () => {
      try {
        const stream = await BrowserPlane.streamTicket(
          session.id,
          currentTab?.tabId
        );
        if (disposed) return;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${protocol}//${window.location.host}${stream.streamPath}`,
          stream.protocol
        );
        streamSocket.current?.close();
        streamSocket.current = socket;
        socket.addEventListener("open", () => {
          reconnectAttempt = 0;
          streamConnected.current = true;
          setStatus("云端 · Playwright Chromium · 实时画面");
          setError(null);
        });
        socket.addEventListener("message", (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === "ready" && message.viewport)
            streamViewport.current = message.viewport;
          if (message.type === "frame" && message.data)
            setFrame(
              `data:${message.mimeType || "image/jpeg"};base64,${message.data}`
            );
          if (message.type === "error") setError(message.code);
        });
        socket.addEventListener("close", () => {
          if (streamSocket.current === socket) streamSocket.current = null;
          streamConnected.current = false;
          if (disposed) return;
          setStatus("云端画面正在重连…");
          const delay = Math.min(5_000, 400 * 2 ** reconnectAttempt++);
          reconnectTimer = window.setTimeout(connect, delay);
        });
      } catch (cause) {
        if (disposed) return;
        streamConnected.current = false;
        setError(cause?.message || "无法建立云端画面流");
        const delay = Math.min(5_000, 400 * 2 ** reconnectAttempt++);
        reconnectTimer = window.setTimeout(connect, delay);
      }
    };
    void connect();
    return () => {
      disposed = true;
      streamConnected.current = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      streamSocket.current?.close();
      streamSocket.current = null;
    };
  }, [currentTab?.tabId, location, session?.id]);

  useEffect(() => {
    if (location !== "cloud" || !session?.id) return;
    let stopped = false;
    const tick = async () => {
      if (
        stopped ||
        document.hidden ||
        streamConnected.current ||
        captureRunning.current
      )
        return;
      captureRunning.current = true;
      try {
        const result = await cloudAction("capture");
        if (!stopped && result?.observation?.frame?.data) {
          setFrame(
            `data:${result.observation.frame.mimeType};base64,${result.observation.frame.data}`
          );
        }
      } catch (cause) {
        if (!stopped) setError(cause?.message || "画面连接中断");
      } finally {
        captureRunning.current = false;
      }
    };
    void tick();
    const timer = window.setInterval(tick, CLOUD_FALLBACK_FRAME_INTERVAL_MS);
    const visible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [cloudAction, location, session?.id]);

  useEffect(() => {
    setAddress(displayUrl(currentTab?.url));
  }, [currentTab?.url]);

  const navigateTo = useCallback(
    async (value) => {
      const target = navigationTarget(value);
      setAddress(target);
      setError(null);
      if (location === "desktop") {
        const next = await desktopNode().navigate(target);
        setDesktopState(next);
      } else {
        await cloudAction("navigate", { url: target });
      }
    },
    [cloudAction, location]
  );

  const command = useCallback(
    async (action) => {
      setError(null);
      if (location === "desktop") {
        const next = await desktopNode().command(action);
        setDesktopState(next);
      } else {
        await cloudAction(action);
      }
    },
    [cloudAction, location]
  );

  const openCookies = async () => {
    try {
      const sites =
        location === "desktop"
          ? await desktopNode().cookies()
          : await BrowserPlane.cookies(session.id);
      setCookieSites(sites || []);
      setSitePermissions(
        location === "desktop" ? await desktopNode().permissionSummary() : null
      );
      setCookieOpen(true);
    } catch (cause) {
      setError(cause?.message || "无法读取站点数据摘要");
    }
  };

  const setSitePermission = async (name, allowed) => {
    if (location !== "desktop") return;
    setSitePermissions(await desktopNode().setSitePermission(name, allowed));
  };

  const findInPage = async (term) => {
    setFindTerm(term);
    if (location === "desktop") {
      const result = await desktopNode().find(term);
      setFindCount(result?.matches ?? null);
      return;
    }
    const result = await cloudAction("find", { term });
    setFindCount(result?.observation?.find?.count ?? 0);
  };

  const applyZoom = async (nextValue) => {
    const factor = Math.max(0.5, Math.min(3, nextValue));
    setZoom(factor);
    if (location === "desktop") await desktopNode().setZoom(factor);
    else await cloudAction("zoom", { factor });
  };

  const saveCapture = async (format = "image") => {
    try {
      const result =
        location === "desktop"
          ? format === "pdf"
            ? await desktopNode().printToPdf()
            : await desktopNode().capture()
          : (
              await cloudAction("capture", {
                fullPage: format === "image",
                format: format === "pdf" ? "pdf" : "jpeg",
              })
            )?.observation?.frame;
      if (!result?.data) throw new Error("浏览器工件生成失败");
      downloadBase64({
        data: result.data,
        mimeType: result.mimeType,
        filename:
          format === "pdf"
            ? `athena-browser-${Date.now()}.pdf`
            : `athena-browser-${Date.now()}.${result.mimeType === "image/png" ? "png" : "jpg"}`,
      });
    } catch (cause) {
      setError(cause?.message || "浏览器工件生成失败");
    }
  };

  const clearCookieSite = async (domain) => {
    if (location === "desktop") await desktopNode().clearCookieSite(domain);
    else await BrowserPlane.clearCookieSite(session.id, domain);
    setCookieSites((sites) => sites.filter((site) => site.domain !== domain));
  };

  const openSidePanel = async (kind) => {
    setSidePanel(kind);
    if (kind === "history") setHistory((await BrowserPlane.history()) || []);
    if (kind === "bookmarks")
      setBookmarks((await BrowserPlane.bookmarks()) || []);
  };

  const addBookmark = async () => {
    if (!currentTab?.url || currentTab.url === "about:blank") return;
    const created = await BrowserPlane.addBookmark({
      url: currentTab.url,
      title: currentTab.title || currentTab.url,
    });
    setBookmarks((current) => [
      created,
      ...current.filter((item) => item.id !== created.id),
    ]);
  };

  const changeNetworkRoute = async (nextRoute) => {
    const node = desktopNode();
    if (!node || location !== "desktop" || routeBusy) return;
    const previous = networkRoute;
    setRouteBusy(true);
    setError(null);
    try {
      if (nextRoute === "athena_egress") {
        const capabilities = node.capabilities();
        if (!capabilities.proxyModes?.includes("athena_egress"))
          throw new Error(
            capabilities.egressCoreError || "当前桌面包尚未安装已签名的出口核心"
          );
        const enrolled = await BrowserPlane.enrollEgress("default", {
          nodeId: node.nodeId(),
        });
        try {
          await node.installEgressConfig(enrolled.sealedConfig);
          const next = await node.applyNetworkRoute("athena_egress");
          const confirmed = await BrowserPlane.confirmProfileRoute("default", {
            nodeId: node.nodeId(),
            networkRoute: "athena_egress",
            connected: Boolean(next?.network?.connected),
            latencyMs: next?.network?.latencyMs ?? null,
          });
          setDesktopState(next);
          setNetworkState(
            next.network || confirmed?.network || enrolled.network
          );
        } catch (cause) {
          if (enrolled?.grant?.id)
            await BrowserPlane.revokeEgress(enrolled.grant.id).catch(
              () => null
            );
          await BrowserPlane.setProfileRoute("default", {
            networkRoute: previous,
            preferredDriver: "embedded",
          }).catch(() => null);
          throw cause;
        }
      } else {
        const next = await node.applyNetworkRoute(nextRoute);
        try {
          const profile = await BrowserPlane.setProfileRoute("default", {
            networkRoute: nextRoute,
            preferredDriver: "embedded",
          });
          await BrowserPlane.confirmProfileRoute("default", {
            nodeId: node.nodeId(),
            networkRoute: nextRoute,
            connected: Boolean(next?.network?.connected),
            latencyMs: next?.network?.latencyMs ?? null,
          });
          setNetworkState(next.network || profile.network);
          setDesktopState(next);
        } catch (cause) {
          await node.applyNetworkRoute(previous).catch(() => null);
          throw cause;
        }
      }
      setNetworkRoute(nextRoute);
      setStatus(
        nextRoute === "athena_egress"
          ? "本机 · WebContentsView · Athena海外出口"
          : nextRoute === "direct"
            ? "本机 · WebContentsView · 本地直连"
            : "本机 · WebContentsView · 系统代理"
      );
    } catch (cause) {
      await BrowserPlane.confirmProfileRoute("default", {
        nodeId: node.nodeId(),
        networkRoute: nextRoute,
        connected: false,
        errorCode: [
          "browser_egress_grant_expired",
          "browser_egress_remote_probe_failed",
          "browser_egress_local_proxy_start_timeout",
          "browser_egress_gateway_unavailable",
        ].includes(cause?.message)
          ? cause.message
          : "route_activation_failed",
      }).catch(() => null);
      setError(cause?.message || "切换网络出口失败");
    } finally {
      setRouteBusy(false);
    }
  };

  const openInSystemChrome = async () => {
    if (location !== "desktop" || !session?.id) return;
    try {
      const instruction = await BrowserPlane.openSystemChrome(
        session.id,
        currentTab?.url || DEFAULT_URL
      );
      await desktopNode().openSystemChrome({
        url: instruction.url,
        profileId: instruction.profileId,
      });
    } catch (cause) {
      setError(cause?.message || "无法打开Athena管理的真实Chrome");
    }
  };

  const compatibilitySensitive = useMemo(() => {
    try {
      const host = new URL(currentTab?.url || "about:blank").hostname;
      return (
        host === "accounts.google.com" ||
        host === "youtube.com" ||
        host.endsWith(".youtube.com")
      );
    } catch {
      return false;
    }
  }, [currentTab?.url]);

  const cloudPointer = async (event) => {
    if (location !== "cloud" || !frame) return;
    if (suppressNextClick.current) {
      suppressNextClick.current = false;
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const viewport = streamViewport.current;
    const scale = Math.min(
      rect.width / viewport.width,
      rect.height / viewport.height
    );
    const offsetX = (rect.width - viewport.width * scale) / 2;
    const offsetY = (rect.height - viewport.height * scale) / 2;
    const x = (event.clientX - rect.left - offsetX) / scale;
    const y = (event.clientY - rect.top - offsetY) / scale;
    if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return;
    const socket = streamSocket.current;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({ type: "input", action: "click", arguments: { x, y } })
      );
    else await cloudAction("click", { x, y });
    event.currentTarget.focus();
  };

  const cloudKey = async (event) => {
    if (location !== "cloud") return;
    event.preventDefault();
    const argumentsValue =
      event.key.length === 1 ? { text: event.key } : { key: event.key };
    const socket = streamSocket.current;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: "input",
          action: "key",
          arguments: argumentsValue,
        })
      );
    else await cloudAction("key", argumentsValue);
  };

  const sendCloudInput = useCallback(
    async (action, argumentsValue) => {
      const socket = streamSocket.current;
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "input",
            action,
            arguments: argumentsValue,
          })
        );
        return;
      }
      await cloudAction(action, argumentsValue);
    },
    [cloudAction]
  );

  const submitCloudText = async () => {
    if (!cloudText) return;
    await sendCloudInput("key", { text: cloudText });
    setCloudText("");
  };

  const beginCloudTouch = (event) => {
    if (location !== "cloud" || event.touches.length !== 1) return;
    touchPoint.current = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
      moved: false,
    };
  };

  const moveCloudTouch = (event) => {
    if (location !== "cloud" || !touchPoint.current) return;
    const touch = event.touches[0];
    if (!touch) return;
    const deltaX = touchPoint.current.x - touch.clientX;
    const deltaY = touchPoint.current.y - touch.clientY;
    touchPoint.current = {
      x: touch.clientX,
      y: touch.clientY,
      moved: touchPoint.current.moved || Math.hypot(deltaX, deltaY) > 4,
    };
    if (Math.hypot(deltaX, deltaY) < 2) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastTouchSentAt.current < 35) return;
    lastTouchSentAt.current = now;
    void sendCloudInput("scroll", {
      deltaX: Math.round(deltaX * 1.4),
      deltaY: Math.round(deltaY * 1.4),
    });
  };

  const endCloudTouch = () => {
    suppressNextClick.current = Boolean(touchPoint.current?.moved);
    touchPoint.current = null;
  };

  const newTab = async () => {
    if (location === "desktop") setDesktopState(await desktopNode().newTab());
    else {
      const next = await BrowserPlane.newTab(session.id);
      setSession((current) => ({ ...current, ...next }));
    }
  };

  const selectTab = async (tabId) => {
    if (location === "desktop")
      setDesktopState(await desktopNode().selectTab(tabId));
    else setSession((current) => ({ ...current, currentTabId: tabId }));
  };

  const closeTab = async (tabId) => {
    if (location === "desktop")
      setDesktopState(await desktopNode().closeTab(tabId));
    else {
      const next = await BrowserPlane.closeTab(session.id, tabId);
      setSession((current) => ({ ...current, ...next }));
    }
  };

  const tabs =
    location === "desktop" ? desktopState?.tabs || [] : session?.tabs || [];

  return (
    <div className="relative flex h-dvh min-h-[640px] w-full flex-col overflow-hidden bg-theme-bg-primary light:bg-slate-50">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 bg-theme-bg-secondary px-3 light:border-slate-200 light:bg-white">
        <ToolbarButton
          label="返回Athena"
          onClick={() => navigate(paths.home())}
        >
          <House className="h-4 w-4" />
        </ToolbarButton>
        <div className="mr-2 flex items-center gap-2 text-sm font-semibold text-theme-text-primary">
          <GlobeHemisphereWest className="h-5 w-5 text-cyan-400" />
          <span className="hidden sm:inline">Browser Center</span>
        </div>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto no-scroll">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.tabId}
              onClick={() => selectTab(tab.tabId)}
              className={`group flex h-8 min-w-[130px] max-w-[220px] items-center gap-2 rounded-t-xl px-3 text-xs ${
                tab.tabId === currentTab?.tabId
                  ? "bg-theme-bg-primary text-theme-text-primary light:bg-slate-100"
                  : "text-theme-text-secondary hover:bg-white/5"
              }`}
            >
              <GlobeHemisphereWest className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">
                {tab.title || tab.url || "新标签页"}
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.tabId);
                }}
                className="opacity-50 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
          <ToolbarButton label="新建标签页" onClick={newTab}>
            <Plus className="h-4 w-4" />
          </ToolbarButton>
        </div>
      </div>

      <div className="flex h-[54px] shrink-0 items-center gap-1.5 overflow-x-auto border-b border-white/10 bg-theme-bg-secondary px-3 light:border-slate-200 light:bg-white">
        <ToolbarButton label="后退" onClick={() => command("back")}>
          <ArrowLeft className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton label="前进" onClick={() => command("forward")}>
          <ArrowRight className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton label="刷新" onClick={() => command("reload")}>
          <ArrowClockwise className="h-4 w-4" />
        </ToolbarButton>
        <form
          className="mx-1 flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-black/10 px-3 light:border-slate-200 light:bg-slate-100"
          onSubmit={(event) => {
            event.preventDefault();
            void navigateTo(address);
          }}
        >
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="搜索网页或输入网址"
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-theme-text-primary outline-none placeholder:text-theme-text-secondary"
          />
          <MagnifyingGlass className="h-4 w-4 shrink-0 text-theme-text-secondary" />
        </form>
        <ToolbarButton label="收藏当前页" onClick={addBookmark}>
          <Star className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          label="站点Cookie"
          onClick={openCookies}
          active={cookieOpen}
        >
          <Cookie className="h-4 w-4" />
        </ToolbarButton>
        <div className="relative ml-1 hidden sm:block">
          <select
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            className="h-9 appearance-none rounded-xl border border-white/10 bg-theme-bg-primary pl-8 pr-7 text-xs font-medium text-theme-text-primary outline-none light:border-slate-200 light:bg-slate-100"
          >
            {desktopNode() ? <option value="desktop">本机浏览器</option> : null}
            <option value="cloud">云端浏览器</option>
          </select>
          <Desktop className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-cyan-400" />
          <CaretDown className="pointer-events-none absolute right-2 top-3 h-3 w-3 text-theme-text-secondary" />
        </div>
        {location === "desktop" && canManageEgress ? (
          <div className="relative hidden lg:block">
            <select
              aria-label="浏览器网络出口"
              value={networkRoute}
              disabled={routeBusy}
              onChange={(event) => void changeNetworkRoute(event.target.value)}
              className="h-9 appearance-none rounded-xl border border-white/10 bg-theme-bg-primary pl-3 pr-7 text-xs font-medium text-theme-text-primary outline-none disabled:opacity-50 light:border-slate-200 light:bg-slate-100"
            >
              <option value="direct">本地直连</option>
              <option value="system">系统代理</option>
              <option value="athena_egress">Athena海外出口</option>
            </select>
            <CaretDown className="pointer-events-none absolute right-2 top-3 h-3 w-3 text-theme-text-secondary" />
          </div>
        ) : null}
        {location === "desktop" && compatibilitySensitive ? (
          <button
            type="button"
            onClick={() => void openInSystemChrome()}
            className="hidden h-9 shrink-0 rounded-xl border border-amber-400/30 px-3 text-xs text-amber-300 hover:bg-amber-400/10 xl:block light:text-amber-700"
          >
            使用真实Chrome
          </button>
        ) : null}
        <ToolbarButton
          label="历史和书签"
          onClick={() => openSidePanel(sidePanel ? null : "history")}
          active={Boolean(sidePanel)}
        >
          <SidebarSimple className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          label="页面内查找"
          onClick={() => setFindOpen((value) => !value)}
          active={findOpen}
        >
          <span className="text-xs font-semibold">Aa</span>
        </ToolbarButton>
        <ToolbarButton label="缩小" onClick={() => applyZoom(zoom - 0.1)}>
          <span className="text-lg">−</span>
        </ToolbarButton>
        <span className="hidden w-10 text-center text-[10px] text-theme-text-secondary lg:block">
          {Math.round(zoom * 100)}%
        </span>
        <ToolbarButton label="放大" onClick={() => applyZoom(zoom + 0.1)}>
          <span className="text-lg">＋</span>
        </ToolbarButton>
        <ToolbarButton label="保存截图" onClick={() => saveCapture("image")}>
          <span className="text-[10px] font-semibold">PNG</span>
        </ToolbarButton>
        <ToolbarButton label="保存PDF" onClick={() => saveCapture("pdf")}>
          <span className="text-[10px] font-semibold">PDF</span>
        </ToolbarButton>
        <ToolbarButton
          label="浏览器全屏"
          onClick={() => viewportRef.current?.requestFullscreen?.()}
        >
          <span className="text-base">⛶</span>
        </ToolbarButton>
        {location === "cloud" ? (
          <ToolbarButton
            label="输入文字"
            onClick={() => setCloudTextOpen((value) => !value)}
            active={cloudTextOpen}
          >
            <Keyboard className="h-4 w-4" />
          </ToolbarButton>
        ) : null}
      </div>

      {cloudTextOpen && location === "cloud" ? (
        <form
          className="absolute inset-x-3 bottom-4 z-30 flex items-center gap-2 rounded-2xl border border-white/10 bg-theme-bg-secondary/95 p-2 shadow-2xl backdrop-blur-xl light:border-slate-200 light:bg-white/95 sm:bottom-auto sm:left-auto sm:right-4 sm:top-[112px] sm:w-[420px]"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCloudText();
          }}
        >
          <input
            autoFocus
            value={cloudText}
            onChange={(event) => setCloudText(event.target.value)}
            placeholder="输入到当前网页焦点"
            className="h-9 min-w-0 flex-1 rounded-xl bg-black/10 px-3 text-sm text-theme-text-primary outline-none light:bg-slate-100"
          />
          <button
            type="submit"
            className="h-9 shrink-0 rounded-xl bg-cyan-500 px-4 text-xs font-semibold text-slate-950"
          >
            输入
          </button>
          <ToolbarButton
            label="关闭文字输入"
            onClick={() => setCloudTextOpen(false)}
          >
            <X className="h-4 w-4" />
          </ToolbarButton>
        </form>
      ) : null}

      {findOpen ? (
        <form
          className="absolute right-4 top-[112px] z-20 flex items-center gap-2 rounded-xl border border-white/10 bg-theme-bg-secondary/95 p-2 shadow-xl backdrop-blur light:border-slate-200 light:bg-white/95"
          onSubmit={(event) => {
            event.preventDefault();
            void findInPage(findTerm);
          }}
        >
          <input
            autoFocus
            value={findTerm}
            onChange={(event) => setFindTerm(event.target.value)}
            placeholder="在网页中查找"
            className="h-8 w-48 rounded-lg bg-black/10 px-3 text-xs text-theme-text-primary outline-none light:bg-slate-100"
          />
          <span className="min-w-8 text-center text-[11px] text-theme-text-secondary">
            {findCount == null ? "" : findCount}
          </span>
          <ToolbarButton label="查找" onClick={() => findInPage(findTerm)}>
            <MagnifyingGlass className="h-4 w-4" />
          </ToolbarButton>
        </form>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#111]">
        <div
          ref={viewportRef}
          tabIndex={0}
          onClick={cloudPointer}
          onKeyDown={cloudKey}
          onTouchStart={beginCloudTouch}
          onTouchMove={moveCloudTouch}
          onTouchEnd={endCloudTouch}
          onTouchCancel={endCloudTouch}
          onWheel={(event) => {
            if (location !== "cloud") return;
            event.preventDefault();
            const argumentsValue = {
              deltaX: event.deltaX,
              deltaY: event.deltaY,
            };
            const socket = streamSocket.current;
            if (socket?.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({
                  type: "input",
                  action: "scroll",
                  arguments: argumentsValue,
                })
              );
            else void cloudAction("scroll", argumentsValue);
          }}
          className="h-full w-full touch-none overflow-hidden outline-none"
        >
          {location === "cloud" ? (
            frame ? (
              <img
                src={frame}
                alt="云端浏览器画面"
                draggable={false}
                className="h-full w-full select-none object-contain"
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">
                {status}
              </div>
            )
          ) : (
            <div className="pointer-events-none flex h-full items-end justify-center pb-3 text-xs text-white/45">
              本机网页由安全隔离的WebContentsView渲染
            </div>
          )}
        </div>
        <div className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-white/10 bg-black/65 px-3 py-1 text-[11px] text-white/80 backdrop-blur">
          {status}
        </div>
        {location === "desktop" && networkRoute === "athena_egress" ? (
          <div className="pointer-events-none absolute bottom-3 right-3 max-w-[420px] rounded-xl border border-amber-400/20 bg-black/70 px-3 py-2 text-[10px] text-amber-100 backdrop-blur">
            Athena海外出口 · {networkState?.connected ? "已连接" : "未确认"}
            {egressStatus?.gatewayStatus?.checkedAt
              ? ` · 最近探测 ${new Date(egressStatus.gatewayStatus.checkedAt).toLocaleTimeString()}`
              : ""}
            <span className="ml-2 text-white/60">
              不保证目标网站在所有地区均可访问
            </span>
          </div>
        ) : null}
        {error ? (
          <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-xl border border-red-400/30 bg-red-950/90 px-4 py-2 text-xs text-red-100 shadow-xl">
            {error}
          </div>
        ) : null}
      </div>

      {cookieOpen ? (
        <CookiePanel
          sites={cookieSites}
          onClose={() => setCookieOpen(false)}
          onClear={clearCookieSite}
          permissions={sitePermissions}
          onPermission={setSitePermission}
        />
      ) : null}

      {sidePanel ? (
        <aside className="absolute bottom-4 right-4 top-[112px] z-30 w-[min(360px,calc(100%-32px))] overflow-hidden rounded-2xl border border-white/10 bg-theme-bg-secondary/95 shadow-2xl backdrop-blur-xl light:border-slate-200 light:bg-white/95">
          <div className="flex items-center justify-between border-b border-white/10 p-3 light:border-slate-200">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => openSidePanel("history")}
                className={`rounded-lg px-3 py-1.5 text-xs ${sidePanel === "history" ? "bg-cyan-400/15 text-cyan-300 light:text-cyan-700" : "text-theme-text-secondary"}`}
              >
                历史
              </button>
              <button
                type="button"
                onClick={() => openSidePanel("bookmarks")}
                className={`rounded-lg px-3 py-1.5 text-xs ${sidePanel === "bookmarks" ? "bg-cyan-400/15 text-cyan-300 light:text-cyan-700" : "text-theme-text-secondary"}`}
              >
                书签
              </button>
            </div>
            <ToolbarButton label="关闭" onClick={() => setSidePanel(null)}>
              <X className="h-4 w-4" />
            </ToolbarButton>
          </div>
          <div className="h-[calc(100%-58px)] overflow-y-auto p-2">
            {(sidePanel === "history" ? history : bookmarks).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.urlWithoutQuery)}
                className="mb-1 flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-white/5 light:hover:bg-slate-100"
              >
                <BookmarkSimple className="h-4 w-4 shrink-0 text-cyan-400" />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-theme-text-primary">
                    {item.title || item.origin}
                  </span>
                  <span className="block truncate text-[11px] text-theme-text-secondary">
                    {item.urlWithoutQuery}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
