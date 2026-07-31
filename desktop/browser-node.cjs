const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebContentsView, session } = require("electron");
const { browserWebContentsViewOptions } = require("./security-policy.cjs");

const CONTRACT = "athena.browser.driver.v1";
const MAX_TABS = 8;

function safeId(value = "default") {
  return String(value || "default")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 96);
}

function profilePartition(accountRef, profileId) {
  const accountHash = crypto
    .createHash("sha256")
    .update(String(accountRef || "local-account"))
    .digest("hex")
    .slice(0, 24);
  return `persist:athena-browser:${accountHash}:${safeId(profileId)}`;
}

function allowedNavigation(value) {
  try {
    const url = new URL(String(value));
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return value === "about:blank";
  }
}

function compactUrl(value = "") {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value === "about:blank" ? value : null;
  }
}

function siteUrl(cookie) {
  const host = String(cookie.domain || "").replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
}

class DesktopBrowserNode {
  constructor({ app, mainWindow, log = () => {} } = {}) {
    this.app = app;
    this.mainWindow = mainWindow;
    this.log = log;
    this.tabs = new Map();
    this.currentTabId = null;
    this.partition = null;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.attached = false;
    this.sitePermissions = new Map();
    this.nodeId = this.loadNodeId();
  }

  loadNodeId() {
    const file = path.join(this.app.getPath("userData"), "browser-node-id");
    try {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (/^[a-zA-Z0-9_-]{8,128}$/.test(existing)) return existing;
    } catch {}
    const id = `desktop-${crypto.randomUUID()}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
    return id;
  }

  capabilities() {
    return {
      contract: CONTRACT,
      driver: "electron-webcontentsview",
      platform: process.platform,
      nonDrmVideo: true,
      downloads: true,
      uploads: true,
      maxTabs: MAX_TABS,
    };
  }

  browserSession() {
    if (!this.partition)
      throw new Error("desktop_browser_profile_not_attached");
    return session.fromPartition(this.partition, { cache: true });
  }

  configureSession(browserSession) {
    if (browserSession.__athenaBrowserConfigured) return;
    browserSession.__athenaBrowserConfigured = true;
    const permitted = (contents, permission, requestingOrigin = null) => {
      if (["fullscreen", "pointerLock"].includes(permission)) return true;
      const origin = this.permissionOrigin(
        requestingOrigin || contents?.getURL?.()
      );
      return Boolean(
        origin && this.sitePermissions.get(origin)?.has(permission)
      );
    };
    browserSession.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(permitted(contents, permission, details?.requestingUrl))
    );
    browserSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin) =>
        permitted(contents, permission, requestingOrigin)
    );
    browserSession.on("will-download", (_event, item) => {
      this.log("Browser download started", {
        bytes: item.getTotalBytes(),
        mimeType: item.getMimeType(),
      });
      item.once("done", (_downloadEvent, state) => {
        this.log("Browser download finished", {
          state,
          bytes: item.getReceivedBytes(),
        });
        this.emitState();
      });
    });
  }

  async attach({ accountRef = "local-account", profileId = "default" } = {}) {
    const nextPartition = profilePartition(accountRef, profileId);
    if (this.partition && this.partition !== nextPartition)
      await this.closeAll();
    this.partition = nextPartition;
    this.configureSession(this.browserSession());
    this.attached = true;
    if (!this.tabs.size) await this.newTab();
    this.showCurrent();
    return this.snapshot();
  }

  async createView() {
    if (this.tabs.size >= MAX_TABS)
      throw new Error("desktop_browser_tab_limit_reached");
    const tabId = crypto.randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        ...browserWebContentsViewOptions(this.partition),
        backgroundThrottling: false,
      },
    });
    const tab = {
      tabId,
      view,
      title: "新标签页",
      url: "about:blank",
      loading: false,
      crashed: false,
    };
    this.tabs.set(tabId, tab);
    const contents = view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedNavigation(url)) void this.newTab(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!allowedNavigation(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!allowedNavigation(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.emitState();
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      tab.url = compactUrl(contents.getURL()) || "about:blank";
      tab.title = contents.getTitle() || tab.url;
      this.emitState();
    });
    contents.on("page-title-updated", (_event, title) => {
      tab.title = String(title || tab.url).slice(0, 512);
      this.emitState();
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.crashed = true;
      tab.loading = false;
      this.log("Browser tab renderer exited", {
        reason: details?.reason,
        exitCode: details?.exitCode,
      });
      this.emitState();
    });
    contents.on("destroyed", () => {
      if (this.tabs.get(tabId)?.view === view) this.tabs.delete(tabId);
    });
    return tab;
  }

  async newTab(url = "about:blank") {
    const tab = await this.createView();
    this.currentTabId = tab.tabId;
    this.showCurrent();
    if (url !== "about:blank") await this.navigate(url);
    else await tab.view.webContents.loadURL("about:blank");
    this.emitState();
    return this.snapshot();
  }

  currentTab() {
    const tab = this.tabs.get(this.currentTabId);
    if (!tab) throw new Error("desktop_browser_tab_not_found");
    return tab;
  }

  showCurrent() {
    if (!this.attached || !this.mainWindow || this.mainWindow.isDestroyed())
      return;
    for (const tab of this.tabs.values()) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch {}
    }
    const tab = this.tabs.get(this.currentTabId);
    if (!tab) return;
    this.mainWindow.contentView.addChildView(tab.view);
    tab.view.setBounds(this.bounds);
  }

  setBounds(bounds = {}) {
    const contentBounds = this.mainWindow.getContentBounds();
    this.bounds = {
      x: Math.max(
        0,
        Math.min(contentBounds.width - 1, Math.round(Number(bounds.x) || 0))
      ),
      y: Math.max(
        0,
        Math.min(contentBounds.height - 1, Math.round(Number(bounds.y) || 0))
      ),
      width: Math.max(
        1,
        Math.min(contentBounds.width, Math.round(Number(bounds.width) || 1))
      ),
      height: Math.max(
        1,
        Math.min(contentBounds.height, Math.round(Number(bounds.height) || 1))
      ),
    };
    const tab = this.tabs.get(this.currentTabId);
    if (this.attached && tab) tab.view.setBounds(this.bounds);
    return this.bounds;
  }

  async navigate(url) {
    if (!allowedNavigation(url))
      throw new Error("desktop_browser_navigation_forbidden");
    const tab = this.currentTab();
    await tab.view.webContents.loadURL(String(url));
    tab.url = compactUrl(url) || "about:blank";
    this.emitState();
    return this.snapshot();
  }

  async command(action) {
    const contents = this.currentTab().view.webContents;
    if (action === "back" && contents.canGoBack()) contents.goBack();
    else if (action === "forward" && contents.canGoForward())
      contents.goForward();
    else if (action === "reload") contents.reload();
    else if (action === "stop") contents.stop();
    else throw new Error("desktop_browser_command_unsupported");
    return this.snapshot();
  }

  selectTab(tabId) {
    if (!this.tabs.has(tabId)) throw new Error("desktop_browser_tab_not_found");
    this.currentTabId = tabId;
    this.showCurrent();
    this.emitState();
    return this.snapshot();
  }

  async closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return this.snapshot();
    try {
      this.mainWindow.contentView.removeChildView(tab.view);
    } catch {}
    tab.view.webContents.close();
    this.tabs.delete(tabId);
    if (!this.tabs.size) return this.newTab();
    if (this.currentTabId === tabId)
      this.currentTabId = this.tabs.keys().next().value;
    this.showCurrent();
    this.emitState();
    return this.snapshot();
  }

  async cookies() {
    const cookies = await this.browserSession().cookies.get({});
    const sites = new Map();
    for (const cookie of cookies) {
      const domain = String(cookie.domain || "")
        .replace(/^\./, "")
        .toLowerCase();
      if (!sites.has(domain)) sites.set(domain, []);
      sites.get(domain).push({
        name: String(cookie.name || "").slice(0, 256),
        expires: cookie.expirationDate
          ? new Date(cookie.expirationDate * 1000).toISOString()
          : null,
        sameSite: cookie.sameSite || null,
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      });
    }
    return [...sites.entries()].map(([domain, entries]) => ({
      domain,
      count: entries.length,
      cookies: entries,
    }));
  }

  async clearCookieSite(domain) {
    const target = String(domain || "")
      .replace(/^\./, "")
      .toLowerCase();
    const cookies = await this.browserSession().cookies.get({ domain: target });
    for (const cookie of cookies) {
      await this.browserSession().cookies.remove(siteUrl(cookie), cookie.name);
    }
    await this.browserSession().clearStorageData({
      origin: `https://${target}`,
      storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage"],
    });
    return { domain: target, cleared: cookies.length };
  }

  permissionOrigin(value) {
    try {
      const url = new URL(String(value || ""));
      return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
    } catch {
      return null;
    }
  }

  permissionSummary() {
    const origin = this.permissionOrigin(this.currentTab()?.url);
    const configured = origin ? this.sitePermissions.get(origin) : null;
    return {
      origin,
      permissions: ["media", "notifications", "geolocation"].map((name) => ({
        name,
        allowed: Boolean(configured?.has(name)),
      })),
    };
  }

  setSitePermission(name, allowed) {
    if (!["media", "notifications", "geolocation"].includes(name))
      throw new Error("desktop_browser_permission_unsupported");
    const origin = this.permissionOrigin(this.currentTab().url);
    if (!origin) throw new Error("desktop_browser_permission_origin_invalid");
    const configured = new Set(this.sitePermissions.get(origin) || []);
    if (allowed) configured.add(name);
    else configured.delete(name);
    this.sitePermissions.set(origin, configured);
    return this.permissionSummary();
  }

  async find(term) {
    const contents = this.currentTab().view.webContents;
    if (!term) {
      contents.stopFindInPage("clearSelection");
      return { matches: 0 };
    }
    return new Promise((resolve) => {
      let settled = false;
      const complete = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        contents.removeListener("found-in-page", onFound);
        resolve(result);
      };
      const onFound = (_event, result) => {
        if (!result?.finalUpdate) return;
        complete({
          requestId: result.requestId,
          matches: Number(result.matches) || 0,
          activeMatchOrdinal: Number(result.activeMatchOrdinal) || 0,
        });
      };
      const timer = setTimeout(
        () => complete({ requestId, matches: 0, timedOut: true }),
        1_500
      );
      contents.on("found-in-page", onFound);
      const requestId = contents.findInPage(String(term).slice(0, 256));
    });
  }

  setZoom(factor) {
    const value = Math.max(0.5, Math.min(3, Number(factor) || 1));
    this.currentTab().view.webContents.setZoomFactor(value);
    return { zoomFactor: value };
  }

  async capture() {
    const image = await this.currentTab().view.webContents.capturePage();
    return {
      mimeType: "image/png",
      data: image.toPNG().toString("base64"),
      capturedAt: new Date().toISOString(),
    };
  }

  async printToPdf() {
    const data = await this.currentTab().view.webContents.printToPDF({
      printBackground: true,
    });
    return { mimeType: "application/pdf", data: data.toString("base64") };
  }

  detach() {
    this.attached = false;
    for (const tab of this.tabs.values()) {
      try {
        this.mainWindow.contentView.removeChildView(tab.view);
      } catch {}
    }
    return this.snapshot();
  }

  async closeAll() {
    this.detach();
    for (const tab of this.tabs.values()) tab.view.webContents.close();
    this.tabs.clear();
    this.currentTabId = null;
  }

  snapshot() {
    return {
      contract: CONTRACT,
      nodeId: this.nodeId,
      executionLocation: "desktop",
      driver: "electron-webcontentsview",
      attached: this.attached,
      currentTabId: this.currentTabId,
      tabs: [...this.tabs.values()].map((tab) => ({
        tabId: tab.tabId,
        title: tab.title,
        url: tab.url,
        loading: tab.loading,
        crashed: tab.crashed,
      })),
    };
  }

  emitState() {
    if (!this.mainWindow?.isDestroyed?.())
      this.mainWindow.webContents.send("browser-node:state", this.snapshot());
  }
}

module.exports = {
  CONTRACT,
  DesktopBrowserNode,
  MAX_TABS,
  allowedNavigation,
  compactUrl,
  profilePartition,
};
