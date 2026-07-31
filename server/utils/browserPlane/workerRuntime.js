const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  assertBrowserDestination,
  browserResult,
  publicObservation,
} = require(".");
const {
  deleteProfile,
  releaseProfile,
  restoreProfile,
} = require("./profileStore");
const { ensureStoragePath } = require("../environment");
const { metrics } = require("../observability/metrics");

const DEFAULT_VIEWPORT = Object.freeze({ width: 1365, height: 768 });
const FRAME_MAX_BYTES = 1_500_000;
const INLINE_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
const STREAM_TICKET_TTL_MS = 60_000;
const STREAM_MESSAGE_MAX_BYTES = 16 * 1024;
const ACTION_ARGUMENT_MAX_BYTES = 64 * 1024;
const INPUT_TEXT_MAX_BYTES = 10 * 1024;
const CAPTURE_MAX_PIXELS = 20_000_000;
const DEFAULT_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 10 * 60_000;
const DEFAULT_MIN_AVAILABLE_MEMORY_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MIN_CGROUP_HEADROOM_BYTES = 256 * 1024 * 1024;
const DEFAULT_MEMORY_ADMISSION_MODE = "host-and-cgroup";
const CGROUP_ISOLATED_MEMORY_ADMISSION_MODE = "cgroup-isolated";

function numericFile(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (!value || value === "max") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

function memorySnapshot() {
  const hostAvailableBytes = os.freemem();
  const cgroupLimit = numericFile("/sys/fs/cgroup/memory.max");
  const cgroupCurrent = numericFile("/sys/fs/cgroup/memory.current");
  const cgroupHeadroomBytes =
    cgroupLimit === null || cgroupCurrent === null
      ? null
      : Math.max(0, cgroupLimit - cgroupCurrent);
  return { hostAvailableBytes, cgroupHeadroomBytes };
}

function availableMemoryBytes() {
  return memorySnapshot().hostAvailableBytes;
}

function memoryAdmission(
  { hostAvailableBytes, cgroupHeadroomBytes },
  {
    minHostAvailableBytes,
    minCgroupHeadroomBytes,
    mode = DEFAULT_MEMORY_ADMISSION_MODE,
  }
) {
  const hostReady = hostAvailableBytes >= minHostAvailableBytes;
  const isolated = mode === CGROUP_ISOLATED_MEMORY_ADMISSION_MODE;
  // An isolated worker is protected by a hard container memory limit. In that
  // mode the cgroup reading is authoritative and must be present; silently
  // falling back to host memory would turn a missing isolation contract into a
  // bypass. Non-isolated desktop/runtime roles keep the stricter host + cgroup
  // policy.
  const cgroupReady =
    cgroupHeadroomBytes === null
      ? !isolated
      : cgroupHeadroomBytes >= minCgroupHeadroomBytes;
  return {
    allowed: isolated ? cgroupReady : hostReady && cgroupReady,
    hostReady,
    cgroupReady,
  };
}

function executablePath() {
  const candidates = [
    process.env.BROWSER_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates)
    if (fs.existsSync(candidate)) return candidate;
  try {
    const playwrightExecutable = playwright().chromium.executablePath();
    if (fs.existsSync(playwrightExecutable)) return playwrightExecutable;
  } catch {
    // Fall through to the legacy Collector browser only for compatibility.
  }
  try {
    const puppeteerExecutable =
      require("../../../collector/node_modules/puppeteer").executablePath();
    return fs.existsSync(puppeteerExecutable) ? puppeteerExecutable : null;
  } catch {
    return null;
  }
}

function playwright() {
  try {
    return require("playwright-core");
  } catch (error) {
    error.code = "browser_playwright_unavailable";
    throw error;
  }
}

function safeIdentifier(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(normalized)) {
    const error = new Error(`${label}_invalid`);
    error.code = `${label}_invalid`;
    error.httpStatus = 400;
    throw error;
  }
  return normalized;
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Math.max(min, Math.min(max, numeric))
    : fallback;
}

function cleanFilename(value = "download") {
  return path
    .basename(String(value || "download"))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function boundedUtf8(value, maxBytes, errorCode) {
  const text = String(value ?? "");
  if (Buffer.byteLength(text, "utf8") > maxBytes)
    throw Object.assign(new Error(errorCode), {
      code: errorCode,
      httpStatus: 413,
    });
  return text;
}

function validateArguments(value) {
  const args =
    value && typeof value === "object" && !Array.isArray(value) ? value : {};
  let serialized;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw Object.assign(new Error("browser_action_arguments_invalid"), {
      code: "browser_action_arguments_invalid",
      httpStatus: 400,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > ACTION_ARGUMENT_MAX_BYTES)
    throw Object.assign(new Error("browser_action_arguments_too_large"), {
      code: "browser_action_arguments_too_large",
      httpStatus: 413,
    });
  return args;
}

class BrowserWorkerRuntime {
  constructor({
    maxSessions = Number(process.env.BROWSER_WORKER_MAX_SESSIONS || 1),
    maxTabs = Number(process.env.BROWSER_WORKER_MAX_TABS || 8),
    idleTimeoutMs = Number(
      process.env.BROWSER_WORKER_IDLE_TIMEOUT_MS || 15 * 60_000
    ),
    minAvailableMemoryBytes = Number(
      process.env.BROWSER_WORKER_MIN_AVAILABLE_MEMORY_BYTES ||
        DEFAULT_MIN_AVAILABLE_MEMORY_BYTES
    ),
    minCgroupHeadroomBytes = Number(
      process.env.BROWSER_WORKER_MIN_CGROUP_HEADROOM_BYTES ||
        DEFAULT_MIN_CGROUP_HEADROOM_BYTES
    ),
    memoryAdmissionMode = String(
      process.env.BROWSER_WORKER_MEMORY_ADMISSION_MODE ||
        DEFAULT_MEMORY_ADMISSION_MODE
    ).trim(),
    downloadMaxBytes = Number(
      process.env.BROWSER_DOWNLOAD_MAX_BYTES || DEFAULT_DOWNLOAD_MAX_BYTES
    ),
  } = {}) {
    this.maxSessions = maxSessions;
    this.maxTabs = maxTabs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.minAvailableMemoryBytes = minAvailableMemoryBytes;
    this.minCgroupHeadroomBytes = minCgroupHeadroomBytes;
    this.memoryAdmissionMode = [
      DEFAULT_MEMORY_ADMISSION_MODE,
      CGROUP_ISOLATED_MEMORY_ADMISSION_MODE,
    ].includes(memoryAdmissionMode)
      ? memoryAdmissionMode
      : DEFAULT_MEMORY_ADMISSION_MODE;
    this.downloadMaxBytes = Math.max(
      1,
      Math.min(DEFAULT_DOWNLOAD_MAX_BYTES, Number(downloadMaxBytes) || 0)
    );
    this.sessions = new Map();
    this.userSessions = new Map();
    this.streamTickets = new Map();
    this.activeStreams = new Set();
    this.accepting = true;
    this.stats = { created: 0, actions: 0, failed: 0, crashed: 0 };
    this.sandboxVerified = false;
    this.sandboxVerifiedAt = null;
    this.sandboxProbeError = null;
    this.sandboxProbe = null;
    this.sweeper = null;
  }

  capabilities() {
    const executable = executablePath();
    let playwrightReady = true;
    try {
      playwright();
    } catch {
      playwrightReady = false;
    }
    const memory = memorySnapshot();
    const admission = memoryAdmission(memory, {
      minHostAvailableBytes: this.minAvailableMemoryBytes,
      minCgroupHeadroomBytes: this.minCgroupHeadroomBytes,
      mode: this.memoryAdmissionMode,
    });
    metrics.browserWorkerAvailableMemory.set(memory.hostAvailableBytes);
    metrics.browserActiveSessions.set(
      { driver: "playwright-chromium" },
      this.sessions.size
    );
    return {
      ready:
        this.accepting &&
        Boolean(executable) &&
        playwrightReady &&
        this.sandboxVerified,
      driver: "playwright-chromium",
      contract: "athena.browser.driver.v1",
      executableAvailable: Boolean(executable),
      playwrightReady,
      sandboxVerified: this.sandboxVerified,
      sandboxVerifiedAt: this.sandboxVerifiedAt,
      sandboxProbeError: this.sandboxProbeError,
      activeSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      maxTabs: this.maxTabs,
      availableMemoryBytes: memory.hostAvailableBytes,
      cgroupHeadroomBytes: memory.cgroupHeadroomBytes,
      minAvailableMemoryBytes: this.minAvailableMemoryBytes,
      minCgroupHeadroomBytes: this.minCgroupHeadroomBytes,
      memoryAdmissionMode: this.memoryAdmissionMode,
      canCreateSession: admission.allowed,
      memoryAdmission: admission,
      ...this.stats,
    };
  }

  start() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), 30_000);
    this.sweeper.unref?.();
  }

  async verifySandbox() {
    if (this.sandboxProbe) return this.sandboxProbe;
    this.sandboxProbe = (async () => {
      const binary = executablePath();
      if (!binary)
        throw Object.assign(new Error("browser_chromium_unavailable"), {
          code: "browser_chromium_unavailable",
        });
      const probeRoot = path.join(
        process.env.BROWSER_WORKER_PROFILE_ROOT ||
          ensureStoragePath("browser-plane", "runtime-probe"),
        ".sandbox-probe",
        `${process.pid}-${crypto.randomUUID()}`
      );
      let context = null;
      try {
        await fs.promises.mkdir(probeRoot, { recursive: true, mode: 0o700 });
        context = await playwright().chromium.launchPersistentContext(
          probeRoot,
          {
            executablePath: binary,
            headless: true,
            chromiumSandbox: true,
            args: [
              "--disable-dev-shm-usage",
              "--disable-background-networking",
            ],
          }
        );
        const page = context.pages()[0] || (await context.newPage());
        await page.goto(
          "data:text/html,<title>Athena Browser Sandbox</title>",
          {
            waitUntil: "domcontentloaded",
            timeout: 10_000,
          }
        );
        if ((await page.title()) !== "Athena Browser Sandbox")
          throw new Error("browser_sandbox_probe_title_mismatch");
        this.sandboxVerified = true;
        this.sandboxVerifiedAt = new Date().toISOString();
        this.sandboxProbeError = null;
        return true;
      } catch (error) {
        this.sandboxVerified = false;
        this.sandboxVerifiedAt = null;
        this.sandboxProbeError = String(
          error?.code || error?.message || "browser_sandbox_probe_failed"
        )
          .replace(/[^a-zA-Z0-9_.:-]/g, "_")
          .slice(0, 160);
        throw Object.assign(new Error("browser_sandbox_probe_failed"), {
          code: "browser_sandbox_probe_failed",
          cause: error,
        });
      } finally {
        await context?.close().catch(() => null);
        await fs.promises.rm(probeRoot, { recursive: true, force: true });
      }
    })();
    return this.sandboxProbe;
  }

  async sweepIdle() {
    const now = Date.now();
    for (const [digest, ticket] of this.streamTickets) {
      if (ticket.expiresAt <= now) this.streamTickets.delete(digest);
    }
    for (const state of this.sessions.values()) {
      for (const [downloadId, download] of state.downloads) {
        if (download.expiresAt > now) continue;
        state.downloads.delete(downloadId);
        await fs.promises.rm(download.filePath, { force: true });
      }
    }
    const deadline = Date.now() - this.idleTimeoutMs;
    for (const state of this.sessions.values()) {
      if (state.lastActiveAt < deadline)
        await this.closeSession(state.sessionId, { reason: "idle" });
    }
  }

  async createSession({
    userRef,
    profileId,
    profileArchive = null,
    viewport = DEFAULT_VIEWPORT,
    locale = "zh-CN",
  } = {}) {
    if (!this.accepting)
      throw Object.assign(new Error("browser_worker_draining"), {
        httpStatus: 503,
      });
    const owner = safeIdentifier(userRef, "browser_user_ref");
    const profile = safeIdentifier(profileId, "browser_profile_id");
    const existingSessionId = this.userSessions.get(owner);
    if (existingSessionId)
      return this.sessionSnapshot(this.sessions.get(existingSessionId));
    if (this.sessions.size >= this.maxSessions)
      throw Object.assign(new Error("browser_worker_capacity_exhausted"), {
        code: "browser_worker_capacity_exhausted",
        httpStatus: 503,
      });
    const memory = memorySnapshot();
    const admission = memoryAdmission(memory, {
      minHostAvailableBytes: this.minAvailableMemoryBytes,
      minCgroupHeadroomBytes: this.minCgroupHeadroomBytes,
      mode: this.memoryAdmissionMode,
    });
    if (!admission.allowed)
      throw Object.assign(new Error("browser_worker_memory_guard_active"), {
        code: "browser_worker_memory_guard_active",
        httpStatus: 503,
        availableMemoryBytes: memory.hostAvailableBytes,
        cgroupHeadroomBytes: memory.cgroupHeadroomBytes,
        memoryAdmission: admission,
      });
    const restored = await restoreProfile(profile, {
      objectRef: profileArchive?.objectRef || null,
      manifest: profileArchive?.manifest || null,
    });
    const { chromium } = playwright();
    const binary = executablePath();
    if (!binary)
      throw Object.assign(new Error("browser_chromium_unavailable"), {
        httpStatus: 503,
      });
    const context = await chromium.launchPersistentContext(restored.activeDir, {
      executablePath: binary,
      headless: true,
      acceptDownloads: true,
      locale,
      viewport: {
        width: clamp(viewport.width, 360, 2560, DEFAULT_VIEWPORT.width),
        height: clamp(viewport.height, 480, 1600, DEFAULT_VIEWPORT.height),
      },
      chromiumSandbox: true,
      args: ["--disable-dev-shm-usage", "--disable-background-networking"],
    });
    const sessionId = crypto.randomUUID();
    const state = {
      sessionId,
      userRef: owner,
      profileId: profile,
      context,
      tabs: new Map(),
      currentTabId: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      restored: restored.restored,
      downloadRoot: path.join(
        path.dirname(path.dirname(restored.activeDir)),
        "downloads",
        safeIdentifier(sessionId, "browser_session_id")
      ),
      downloads: new Map(),
      closing: null,
    };
    context.on("close", () => {
      if (!state.closing) {
        this.stats.crashed += 1;
        metrics.browserCrashes.inc({
          driver: "playwright-chromium",
          failure_class: "context_exit",
        });
      }
    });
    this.sessions.set(sessionId, state);
    this.userSessions.set(owner, sessionId);
    const pages = context.pages();
    const page = pages[0] || (await context.newPage());
    await this.attachPage(state, page);
    this.stats.created += 1;
    metrics.browserActiveSessions.set(
      { driver: "playwright-chromium" },
      this.sessions.size
    );
    return this.sessionSnapshot(state);
  }

  async attachPage(state, page) {
    const tabId = crypto.randomUUID();
    state.tabs.set(tabId, {
      tabId,
      page,
      createdAt: Date.now(),
      lastUrl: "about:blank",
      lastTitle: "",
    });
    state.currentTabId = tabId;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (!/^https?:/i.test(url)) return route.continue();
      try {
        await assertBrowserDestination(url);
        return route.continue();
      } catch {
        return route.abort("blockedbyclient");
      }
    });
    page.on("popup", (popup) => {
      if (state.tabs.size >= this.maxTabs) return void popup.close();
      void this.attachPage(state, popup);
    });
    page.on("domcontentloaded", async () => {
      const tab = state.tabs.get(tabId);
      if (!tab) return;
      tab.lastUrl = page.url();
      tab.lastTitle = String(await page.title().catch(() => "")).slice(0, 512);
    });
    page.on("crash", () => {
      this.stats.crashed += 1;
      metrics.browserCrashes.inc({
        driver: "playwright-chromium",
        failure_class: "renderer_crash",
      });
    });
    return tabId;
  }

  requireSession(sessionId, userRef = null) {
    const state = this.sessions.get(String(sessionId || ""));
    if (!state)
      throw Object.assign(new Error("browser_session_not_found"), {
        httpStatus: 404,
      });
    if (userRef && state.userRef !== String(userRef))
      throw Object.assign(new Error("browser_session_scope_denied"), {
        httpStatus: 403,
      });
    state.lastActiveAt = Date.now();
    return state;
  }

  requireTab(state, tabId = null) {
    const id = String(tabId || state.currentTabId || "");
    const tab = state.tabs.get(id);
    if (!tab)
      throw Object.assign(new Error("browser_tab_not_found"), {
        httpStatus: 404,
      });
    state.currentTabId = id;
    return tab;
  }

  sessionSnapshot(state) {
    return {
      sessionId: state.sessionId,
      profileId: state.profileId,
      executionLocation: "cloud",
      driver: "playwright-chromium",
      status: state.closing ? "closing" : "active",
      restored: state.restored,
      currentTabId: state.currentTabId,
      tabs: [...state.tabs.values()].map((tab) => ({
        tabId: tab.tabId,
        title: tab.lastTitle || null,
        url: /^https?:/i.test(tab.page.url())
          ? new URL(tab.page.url()).origin + new URL(tab.page.url()).pathname
          : tab.page.url(),
      })),
      createdAt: new Date(state.createdAt).toISOString(),
      lastActiveAt: new Date(state.lastActiveAt).toISOString(),
    };
  }

  issueStreamTicket({ sessionId, userRef, tabId = null } = {}) {
    const state = this.requireSession(sessionId, userRef);
    const tab = this.requireTab(state, tabId);
    const token = crypto.randomBytes(32).toString("base64url");
    const digest = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = Date.now() + STREAM_TICKET_TTL_MS;
    this.streamTickets.set(digest, {
      sessionId: state.sessionId,
      userRef: state.userRef,
      tabId: tab.tabId,
      expiresAt,
    });
    return {
      ticket: token,
      expiresAt: new Date(expiresAt).toISOString(),
      sessionId: state.sessionId,
      tabId: tab.tabId,
    };
  }

  consumeStreamTicket(token) {
    const digest = crypto
      .createHash("sha256")
      .update(String(token || ""))
      .digest("hex");
    const ticket = this.streamTickets.get(digest);
    this.streamTickets.delete(digest);
    if (!ticket || ticket.expiresAt <= Date.now())
      throw Object.assign(new Error("browser_stream_ticket_invalid"), {
        httpStatus: 401,
      });
    const state = this.requireSession(ticket.sessionId, ticket.userRef);
    const tab = this.requireTab(state, ticket.tabId);
    return { state, tab };
  }

  async attachStream(socket, token) {
    let bound;
    try {
      bound = this.consumeStreamTicket(token);
    } catch (error) {
      socket.close(4401, String(error.message).slice(0, 120));
      return;
    }
    const { state, tab } = bound;
    const page = tab.page;
    const cdp = await state.context.newCDPSession(page);
    const stream = {
      socket,
      cdp,
      sessionId: state.sessionId,
      tabId: tab.tabId,
    };
    this.activeStreams.add(stream);
    let lastFrameAt = 0;
    let closed = false;
    const send = (payload) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      this.activeStreams.delete(stream);
      await cdp.send("Page.stopScreencast").catch(() => null);
      await cdp.detach().catch(() => null);
    };
    cdp.on("Page.screencastFrame", async (frame) => {
      await cdp
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => null);
      const now = Date.now();
      if (now - lastFrameAt < 83 || frame.data.length > FRAME_MAX_BYTES * 1.4)
        return;
      lastFrameAt = now;
      send({
        type: "frame",
        mimeType: "image/jpeg",
        data: frame.data,
        metadata: frame.metadata,
        sessionId: state.sessionId,
        tabId: tab.tabId,
      });
    });
    socket.on("message", async (raw) => {
      try {
        if (Buffer.byteLength(raw) > STREAM_MESSAGE_MAX_BYTES)
          throw new Error("browser_stream_message_too_large");
        const message = JSON.parse(String(raw));
        state.lastActiveAt = Date.now();
        if (message.type === "ping") return send({ type: "pong" });
        if (message.type !== "input")
          throw new Error("browser_stream_message_unsupported");
        const args = message.arguments || {};
        switch (message.action) {
          case "click":
            await page.mouse.click(
              clamp(args.x, 0, 10_000, 0),
              clamp(args.y, 0, 10_000, 0)
            );
            break;
          case "scroll":
            await page.mouse.wheel(
              clamp(args.deltaX, -20_000, 20_000, 0),
              clamp(args.deltaY, -20_000, 20_000, 0)
            );
            break;
          case "key":
            if (typeof args.text === "string" && args.text.length)
              await page.keyboard.insertText(args.text.slice(0, 256));
            else await page.keyboard.press(String(args.key || "Enter"));
            break;
          case "resize":
            await page.setViewportSize({
              width: clamp(args.width, 360, 2560, DEFAULT_VIEWPORT.width),
              height: clamp(args.height, 480, 1600, DEFAULT_VIEWPORT.height),
            });
            break;
          default:
            throw new Error("browser_stream_input_unsupported");
        }
        send({ type: "input_ack", requestId: message.requestId || null });
      } catch (error) {
        send({
          type: "error",
          code: String(error.code || error.message || "browser_stream_failed")
            .replace(/[^a-zA-Z0-9_.:-]/g, "_")
            .slice(0, 160),
        });
      }
    });
    socket.once("close", () => void close());
    socket.once("error", () => void close());
    await cdp.send("Page.enable");
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 68,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
    send({
      type: "ready",
      sessionId: state.sessionId,
      tabId: tab.tabId,
      viewport: page.viewportSize(),
    });
  }

  async newTab(sessionId, userRef, url = "about:blank") {
    const state = this.requireSession(sessionId, userRef);
    if (state.tabs.size >= this.maxTabs)
      throw Object.assign(new Error("browser_tab_limit_reached"), {
        httpStatus: 409,
      });
    const page = await state.context.newPage();
    const tabId = await this.attachPage(state, page);
    if (url !== "about:blank")
      await this.action({
        sessionId,
        userRef,
        tabId,
        action: "navigate",
        args: { url },
      });
    return this.sessionSnapshot(state);
  }

  async closeTab(sessionId, userRef, tabId) {
    const state = this.requireSession(sessionId, userRef);
    const tab = this.requireTab(state, tabId);
    await tab.page.close();
    state.tabs.delete(tab.tabId);
    if (!state.tabs.size)
      return this.closeSession(sessionId, {
        userRef,
        reason: "last_tab_closed",
      });
    state.currentTabId = state.tabs.keys().next().value;
    return this.sessionSnapshot(state);
  }

  async observation(
    page,
    { includeText = false, frame = null, find = null, zoomFactor = null } = {}
  ) {
    return publicObservation({
      url: page.url(),
      title: await page.title().catch(() => ""),
      text: includeText
        ? await page
            .locator("body")
            .innerText({ timeout: 3_000 })
            .catch(() => "")
        : null,
      viewport: page.viewportSize(),
      loading: false,
      frame,
      find,
      zoomFactor,
    });
  }

  async action({
    sessionId,
    userRef,
    tabId = null,
    action,
    args = {},
    runId = null,
  } = {}) {
    args = validateArguments(args);
    const startedAt = Date.now();
    const state = this.requireSession(sessionId, userRef);
    const tab = this.requireTab(state, tabId);
    const page = tab.page;
    let artifacts = [];
    let observationOptions = {};
    try {
      switch (action) {
        case "navigate": {
          const { url } = await assertBrowserDestination(args.url);
          await page.goto(url.toString(), {
            waitUntil: "domcontentloaded",
            timeout: clamp(args.timeoutMs, 1_000, 30_000, 15_000),
          });
          break;
        }
        case "back":
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
          break;
        case "forward":
          await page.goForward({
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
          break;
        case "reload":
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
          break;
        case "stop":
          await page.evaluate(() => window.stop());
          break;
        case "scroll":
          await page.mouse.wheel(
            clamp(args.deltaX, -20_000, 20_000, 0),
            clamp(args.deltaY, -20_000, 20_000, 600)
          );
          break;
        case "click":
          if (args.selector)
            await page
              .locator(String(args.selector))
              .first()
              .click({ timeout: 5_000 });
          else
            await page.mouse.click(
              clamp(args.x, 0, 10_000, 0),
              clamp(args.y, 0, 10_000, 0)
            );
          break;
        case "input": {
          const locator = page.locator(String(args.selector || "")).first();
          if (!args.selector)
            throw Object.assign(new Error("browser_input_selector_required"), {
              httpStatus: 400,
            });
          await locator.fill(
            boundedUtf8(
              args.value,
              INPUT_TEXT_MAX_BYTES,
              "browser_input_too_large"
            ),
            { timeout: 5_000 }
          );
          break;
        }
        case "key":
          if (typeof args.text === "string" && args.text.length)
            await page.keyboard.insertText(args.text.slice(0, 256));
          else await page.keyboard.press(String(args.key || "Enter"));
          break;
        case "submit":
          if (args.selector)
            await page.locator(String(args.selector)).first().press("Enter");
          else await page.keyboard.press("Enter");
          break;
        case "find": {
          const term = String(args.term || "").trim();
          const count = term
            ? await page
                .getByText(term, { exact: false })
                .count()
                .catch(() => 0)
            : 0;
          observationOptions.find = { term: term.slice(0, 256), count };
          break;
        }
        case "zoom": {
          const factor = clamp(args.factor, 0.5, 3, 1);
          await page.evaluate((value) => {
            document.documentElement.style.zoom = String(value);
          }, factor);
          observationOptions.zoomFactor = factor;
          break;
        }
        case "extract":
          observationOptions.includeText = true;
          break;
        case "capture": {
          const format = args.format === "pdf" ? "pdf" : "jpeg";
          if (args.fullPage) {
            const dimensions = await page.evaluate(() => ({
              width: Math.max(
                document.documentElement.scrollWidth,
                document.body?.scrollWidth || 0
              ),
              height: Math.max(
                document.documentElement.scrollHeight,
                document.body?.scrollHeight || 0
              ),
            }));
            if (
              dimensions.width * dimensions.height > CAPTURE_MAX_PIXELS ||
              dimensions.width > 4_096 ||
              dimensions.height > 12_000
            )
              throw Object.assign(
                new Error("browser_capture_dimensions_exceeded"),
                {
                  code: "browser_capture_dimensions_exceeded",
                  httpStatus: 413,
                }
              );
          }
          const buffer =
            format === "pdf"
              ? await page.pdf({
                  printBackground: true,
                  preferCSSPageSize: true,
                })
              : await page.screenshot({
                  type: "jpeg",
                  quality: 72,
                  fullPage: Boolean(args.fullPage),
                });
          if (
            buffer.length >
            (format === "pdf" ? INLINE_ARTIFACT_MAX_BYTES : FRAME_MAX_BYTES)
          )
            throw new Error("browser_frame_too_large");
          observationOptions.frame = {
            mimeType: format === "pdf" ? "application/pdf" : "image/jpeg",
            data: buffer.toString("base64"),
            capturedAt: new Date().toISOString(),
          };
          break;
        }
        case "download": {
          if (!args.selector)
            throw Object.assign(
              new Error("browser_download_selector_required"),
              { httpStatus: 400 }
            );
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 15_000 }),
            page.locator(String(args.selector)).first().click(),
          ]);
          const filename = cleanFilename(download.suggestedFilename());
          const downloadPath = await download.path();
          if (!downloadPath)
            throw Object.assign(new Error("browser_download_unavailable"), {
              code: "browser_download_unavailable",
              httpStatus: 502,
            });
          const bytes = (await fs.promises.stat(downloadPath)).size;
          if (bytes > this.downloadMaxBytes) {
            await download.delete().catch(() => null);
            throw Object.assign(new Error("browser_download_too_large"), {
              code: "browser_download_too_large",
              httpStatus: 413,
            });
          }
          const downloadId = crypto.randomUUID();
          await fs.promises.mkdir(state.downloadRoot, {
            recursive: true,
            mode: 0o700,
          });
          const stagedPath = path.join(state.downloadRoot, downloadId);
          await fs.promises.copyFile(
            downloadPath,
            stagedPath,
            fs.constants.COPYFILE_EXCL
          );
          await fs.promises.chmod(stagedPath, 0o600);
          const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
          state.downloads.set(downloadId, {
            downloadId,
            filePath: stagedPath,
            filename,
            mimeType: "application/octet-stream",
            bytes,
            expiresAt,
          });
          artifacts = [
            {
              downloadId,
              type: "download",
              filename,
              mimeType: "application/octet-stream",
              bytes,
              expiresAt: new Date(expiresAt).toISOString(),
              source: "browser-worker-staged",
            },
          ];
          break;
        }
        case "upload": {
          if (!args.selector || !args.filePath)
            throw Object.assign(
              new Error("browser_upload_arguments_required"),
              { httpStatus: 400 }
            );
          const uploadRoot = path.resolve(
            process.env.BROWSER_UPLOAD_STAGING_DIR ||
              ensureStoragePath("browser-plane", "uploads")
          );
          const resolved = path.resolve(String(args.filePath));
          if (!resolved.startsWith(`${uploadRoot}${path.sep}`))
            throw Object.assign(new Error("browser_upload_path_forbidden"), {
              httpStatus: 403,
            });
          await page.locator(String(args.selector)).setInputFiles(resolved);
          break;
        }
        case "fullscreen":
          await page.evaluate(() =>
            document.documentElement.requestFullscreen?.()
          );
          break;
        default:
          throw Object.assign(new Error("browser_action_unsupported"), {
            httpStatus: 400,
          });
      }
      this.stats.actions += 1;
      return browserResult({
        runId: runId || crypto.randomUUID(),
        sessionId: state.sessionId,
        tabId: tab.tabId,
        action,
        observation: await this.observation(page, observationOptions),
        artifacts,
        driver: "playwright-chromium",
        durationMs: Date.now() - startedAt,
        lineage: [
          {
            driverContract: "athena.browser.driver.v1",
            profileId: state.profileId,
          },
        ],
      });
    } catch (error) {
      this.stats.failed += 1;
      error.browserResult = browserResult({
        runId: runId || crypto.randomUUID(),
        sessionId: state.sessionId,
        tabId: tab.tabId,
        status: "failed",
        action,
        driver: "playwright-chromium",
        durationMs: Date.now() - startedAt,
        error: {
          code: String(
            error.code || error.message || "browser_action_failed"
          ).slice(0, 160),
        },
      });
      throw error;
    }
  }

  async cookieSiteSummary(sessionId, userRef) {
    const state = this.requireSession(sessionId, userRef);
    const cookies = await state.context.cookies();
    const groups = new Map();
    for (const cookie of cookies) {
      const domain = String(cookie.domain || "")
        .replace(/^\./, "")
        .toLowerCase();
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain).push({
        name: String(cookie.name || "").slice(0, 256),
        expires:
          cookie.expires > 0
            ? new Date(cookie.expires * 1000).toISOString()
            : null,
        sameSite: cookie.sameSite || null,
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      });
    }
    return [...groups.entries()].map(([domain, entries]) => ({
      domain,
      count: entries.length,
      cookies: entries,
    }));
  }

  downloadFile(sessionId, userRef, downloadId) {
    const state = this.requireSession(sessionId, userRef);
    const download = state.downloads.get(String(downloadId || ""));
    if (!download || download.expiresAt <= Date.now())
      throw Object.assign(new Error("browser_download_not_found"), {
        code: "browser_download_not_found",
        httpStatus: 404,
      });
    return { ...download };
  }

  async deleteDownload(sessionId, userRef, downloadId) {
    const state = this.requireSession(sessionId, userRef);
    const download = state.downloads.get(String(downloadId || ""));
    if (!download) return { deleted: false };
    state.downloads.delete(download.downloadId);
    await fs.promises.rm(download.filePath, { force: true });
    return { deleted: true, downloadId: download.downloadId };
  }

  async inspectActionRisk({
    sessionId,
    userRef,
    tabId = null,
    action,
    args = {},
  } = {}) {
    const state = this.requireSession(sessionId, userRef);
    const tab = this.requireTab(state, tabId);
    const normalizedAction = String(action || "").toLowerCase();
    if (!["click", "input", "key", "submit"].includes(normalizedAction))
      return { intent: "ordinary", detected: false };
    args = validateArguments(args);
    const selector = String(args.selector || "").slice(0, 512);
    const pageEvidence = await tab.page
      .evaluate(
        ({ selector, action }) => {
          const selected = selector
            ? document.querySelector(selector)
            : document.activeElement;
          const element = selected instanceof Element ? selected : null;
          const form = element?.closest?.("form");
          const parts = [
            location.hostname,
            location.pathname,
            action,
            element?.tagName,
            element?.getAttribute?.("type"),
            element?.getAttribute?.("name"),
            element?.getAttribute?.("autocomplete"),
            element?.getAttribute?.("aria-label"),
            element?.textContent?.slice(0, 300),
            form?.getAttribute?.("action"),
            form?.textContent?.slice(0, 700),
          ];
          return {
            text: parts.filter(Boolean).join(" ").toLowerCase().slice(0, 2_000),
            passwordField:
              element?.getAttribute?.("type")?.toLowerCase() === "password",
          };
        },
        { selector, action: normalizedAction }
      )
      .catch(() => ({ text: "", passwordField: false }));
    const text = pageEvidence.text || "";
    const classifications = [
      [
        "password_change",
        pageEvidence.passwordField ||
          /password|passkey|密码|口令|credential/.test(text),
      ],
      [
        "account_delete",
        /delete.{0,24}(account|profile)|remove.{0,24}account|注销账号|删除账号/.test(
          text
        ),
      ],
      [
        "payment",
        /checkout|payment|place order|confirm purchase|pay now|结算|付款|立即支付|确认购买/.test(
          text
        ),
      ],
      [
        "security_setting",
        /security setting|two.factor|2fa|安全设置|双重认证|两步验证/.test(text),
      ],
      [
        "public_publish",
        /publish|post publicly|公开发布|发布文章|立即发布/.test(text),
      ],
      [
        "external_message",
        /send message|send email|发送消息|发送邮件|立即发送/.test(text),
      ],
    ];
    const match = classifications.find(([, detected]) => detected);
    return {
      intent: match?.[0] || "ordinary",
      detected: Boolean(match),
      source: match ? "page_semantics_v1" : "none",
    };
  }

  async clearCookieSite(sessionId, userRef, domain) {
    const state = this.requireSession(sessionId, userRef);
    const target = String(domain || "")
      .replace(/^\./, "")
      .toLowerCase();
    const cookies = await state.context.cookies();
    await state.context.clearCookies({ domain: target });
    return {
      cleared: cookies.filter(
        (cookie) =>
          String(cookie.domain).replace(/^\./, "").toLowerCase() === target
      ).length,
      domain: target,
    };
  }

  async closeSession(
    sessionId,
    { userRef = null, checkpoint = true, reason = "requested" } = {}
  ) {
    const state = this.requireSession(sessionId, userRef);
    if (state.closing) return state.closing;
    state.closing = (async () => {
      await state.context.close().catch(() => null);
      let saved;
      try {
        saved = await releaseProfile(state.profileId, { checkpoint });
      } finally {
        await fs.promises.rm(state.downloadRoot, {
          recursive: true,
          force: true,
        });
        this.sessions.delete(state.sessionId);
        this.userSessions.delete(state.userRef);
        metrics.browserActiveSessions.set(
          { driver: "playwright-chromium" },
          this.sessions.size
        );
      }
      return {
        sessionId: state.sessionId,
        status: "closed",
        reason,
        checkpoint: saved,
      };
    })();
    return state.closing;
  }

  async deleteProfile(profileId, { objectRef = null } = {}) {
    for (const state of this.sessions.values()) {
      if (state.profileId === profileId)
        await this.closeSession(state.sessionId, {
          checkpoint: false,
          reason: "profile_deleted",
        });
    }
    return deleteProfile(profileId, { objectRef });
  }

  async drain() {
    this.accepting = false;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.streamTickets.clear();
    for (const stream of this.activeStreams)
      stream.socket.close(1012, "browser_worker_draining");
    await Promise.allSettled(
      [...this.sessions.keys()].map((sessionId) =>
        this.closeSession(sessionId, { reason: "drain" })
      )
    );
  }
}

module.exports = {
  BrowserWorkerRuntime,
  DEFAULT_MIN_CGROUP_HEADROOM_BYTES,
  DEFAULT_MIN_AVAILABLE_MEMORY_BYTES,
  DEFAULT_VIEWPORT,
  availableMemoryBytes,
  executablePath,
  memoryAdmission,
  memorySnapshot,
};
