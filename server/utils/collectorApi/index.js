const { Agent } = require("undici");
const { redactLogObject, redactLogText } = require("../security/redaction");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { hotdirPath, isWithin, normalizePath } = require("../files");
const api = require("@opentelemetry/api");
const {
  currentOperationContext,
  withOperationSpan,
} = require("../observability/operationContext");
const { loadServiceIdentity } = require("../security/serviceIdentity");

/**
 * @typedef {Object} CollectorOptions
 * @property {string} whisperProvider - The provider to use for whisper, defaults to "local"
 * @property {string} WhisperModelPref - The model to use for whisper if set.
 * @property {string} openAiKey - The API key to use for OpenAI interfacing, mostly passed to OAI Whisper provider.
 * @property {Object} ocr - The OCR options
 * @property {{allowAnyIp: "true"|null|undefined}} runtimeSettings - The runtime settings that are passed to the collector. Persisted across requests.
 */

// When running locally will occupy the 0.0.0.0 hostname space but when deployed inside
// of docker this endpoint is not exposed so it is only on the Docker instances internal network
// so no additional security is needed on the endpoint directly. Auth is done however by the express
// middleware prior to leaving the node-side of the application so that is good enough >:)
class CollectorApi {
  /** @type {number} - The maximum timeout for extension requests in milliseconds */
  extensionRequestTimeout = 15 * 60_000; // 15 minutes
  /** @type {Agent} - The agent for extension requests */
  extensionRequestAgent = new Agent({
    headersTimeout: this.extensionRequestTimeout,
    bodyTimeout: this.extensionRequestTimeout,
  });

  constructor() {
    const { CommunicationKey } = require("../comKey");
    this.comkey = new CommunicationKey();
    this.endpoint =
      process.env.COLLECTOR_ENDPOINT ||
      `http://${
        process.env.NODE_ENV === "development" ? "localhost" : "0.0.0.0"
      }:${process.env.COLLECTOR_PORT || 8888}`;
    this.serviceIdentityAgent = null;
    if (this.endpoint.startsWith("https://")) {
      // Every micro-module has its own SPIFFE identity. Reusing the API
      // identity here both breaks startup for independently deployed roles
      // and destroys the caller boundary at Collector. The monolith keeps the
      // historical API default, while split runtimes present their own role.
      const serviceRole =
        String(process.env.ATHENA_RUNTIME_ROLE || "")
          .trim()
          .toLowerCase() || "api";
      const identity = loadServiceIdentity(serviceRole, { required: true });
      const connect = {
        ca: identity.ca,
        cert: identity.cert,
        key: identity.key,
        servername: identity.serverName || new URL(this.endpoint).hostname,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      };
      this.serviceIdentityAgent = new Agent({
        connect,
        headersTimeout: this.extensionRequestTimeout,
        bodyTimeout: this.extensionRequestTimeout,
      });
      this.extensionRequestAgent = this.serviceIdentityAgent;
    } else if (process.env.ATHENA_SERVICE_MTLS_REQUIRED === "true") {
      throw new Error("collector_production_mtls_required");
    }
  }

  log(text, ...args) {
    console.log(`\x1b[36m[CollectorApi]\x1b[0m ${text}`, ...args);
  }

  #safeReasonFromBody(body = "") {
    if (!body) return null;
    try {
      const parsed = JSON.parse(body);
      const reason =
        parsed?.reason ||
        parsed?.error ||
        parsed?.msg ||
        parsed?.message ||
        JSON.stringify(redactLogObject(parsed)).slice(0, 500);
      return redactLogText(reason);
    } catch {
      return redactLogText(body.slice(0, 500));
    }
  }

  async #throwIfFailed(res, route = "collector request") {
    if (res.ok) return;
    const body = await res.text().catch(() => "");
    const reason = this.#safeReasonFromBody(body);
    throw new Error(
      `${route} failed (${res.status})${
        reason ? `: ${reason}` : ": Response could not be completed"
      }`
    );
  }

  #safeHotdirInput(filename) {
    const uploadId = String(filename || "").trim();
    if (!uploadId || path.basename(uploadId) !== uploadId) {
      throw new Error("collector_invalid_upload_handle");
    }
    const candidate = normalizePath(path.resolve(hotdirPath, uploadId));
    if (!isWithin(hotdirPath, candidate)) {
      throw new Error("collector_invalid_upload_handle");
    }
    return { uploadId, path: candidate, staged: false };
  }

  #copyToOpaqueHotdirHandle(sourcePath, displayName = null) {
    const source = normalizePath(path.resolve(sourcePath));
    const extension = path.extname(displayName || source).slice(0, 16);
    const uploadId = `upload_${crypto.randomUUID()}${extension}`;
    fs.mkdirSync(hotdirPath, { recursive: true });
    const destination = normalizePath(path.resolve(hotdirPath, uploadId));
    if (!isWithin(hotdirPath, destination)) {
      throw new Error("collector_invalid_upload_handle");
    }
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    return { uploadId, path: destination, staged: true };
  }

  #stageExistingHotdirInput(filename) {
    const source = this.#safeHotdirInput(filename);
    const staged = this.#copyToOpaqueHotdirHandle(source.path, filename);
    return { ...staged, originalPath: source.path };
  }

  #removeStagedInput(stagedInput) {
    if (!stagedInput?.path) return;
    try {
      const candidate = normalizePath(path.resolve(stagedInput.path));
      if (isWithin(hotdirPath, candidate))
        fs.rmSync(candidate, { force: true });
      if (stagedInput.originalPath) {
        const original = normalizePath(path.resolve(stagedInput.originalPath));
        if (isWithin(hotdirPath, original))
          fs.rmSync(original, { force: true });
      }
    } catch {}
  }

  /**
   * Attach options to the request passed to the collector API
   * @returns {CollectorOptions}
   */
  #attachOptions() {
    return {
      whisperProvider: process.env.WHISPER_PROVIDER || "local",
      WhisperModelPref: process.env.WHISPER_MODEL_PREF,
      openAiKey: process.env.OPEN_AI_KEY || null,
      ocr: {
        langList: process.env.TARGET_OCR_LANG || "eng",
      },
      runtimeSettings: {
        allowAnyIp: process.env.COLLECTOR_ALLOW_ANY_IP ?? "false",
        browserLaunchArgs: process.env.ANYTHINGLLM_CHROMIUM_ARGS ?? [],
      },
    };
  }

  #protectedHeaders(requestPath, method, body) {
    return {
      "Content-Type": "application/json",
      ...this.comkey.signRequest({
        method,
        requestPath,
        body,
      }),
    };
  }

  async #fetch(url, options = {}) {
    return withOperationSpan(
      "http.client.collector",
      {
        kind: api.SpanKind.CLIENT,
        attributes: {
          "server.address": "collector",
          "http.request.method": String(options.method || "GET").toUpperCase(),
        },
      },
      async () => {
        const carrier = {};
        api.propagation.inject(api.context.active(), carrier);
        const context = currentOperationContext() || {};
        const correlationHeaders = {
          ...(context.operationId
            ? { "X-Athena-Operation-Id": context.operationId }
            : {}),
          ...(context.interactionId
            ? { "X-Athena-Interaction-Id": context.interactionId }
            : {}),
          ...(context.requestId ? { "X-Request-Id": context.requestId } : {}),
        };
        return fetch(url, {
          ...options,
          headers: {
            ...carrier,
            ...correlationHeaders,
            ...(options.headers || {}),
          },
          dispatcher: options.dispatcher || this.serviceIdentityAgent,
        });
      }
    );
  }

  async online() {
    return await this.#fetch(this.endpoint)
      .then((res) => res.ok)
      .catch(() => false);
  }

  async acceptedFileTypes() {
    return await this.#fetch(`${this.endpoint}/accepts`)
      .then((res) => {
        if (!res.ok) throw new Error("failed to GET /accepts");
        return res.json();
      })
      .then((res) => res)
      .catch((e) => {
        this.log(e.message);
        return null;
      });
  }

  /**
   * Process a document
   * - Will append the options and optional metadata to the request body
   * @param {string} filename - The filename of the document to process
   * @param {Object} metadata - Optional metadata key:value pairs
   * @returns {Promise<Object>} - The response from the collector API
   */
  async processDocument(filename = "", metadata = {}) {
    if (!filename) return false;
    let stagedInput = null;

    try {
      stagedInput = this.#stageExistingHotdirInput(filename);

      const data = JSON.stringify({
        uploadId: stagedInput.uploadId,
        metadata,
        options: this.#attachOptions(),
      });

      const response = await this.#fetch(`${this.endpoint}/process`, {
        method: "POST",
        headers: this.#protectedHeaders("/process", "POST", data),
        body: data,
        dispatcher:
          this.serviceIdentityAgent || new Agent({ headersTimeout: 600000 }),
      });
      await this.#throwIfFailed(response, "POST /process");
      return await response.json();
    } catch (error) {
      this.log(error.message);
      return { success: false, reason: error.message, documents: [] };
    } finally {
      this.#removeStagedInput(stagedInput);
    }
  }

  /**
   * Process a link
   * - Will append the options to the request body
   * @param {string} link - The link to process
   * @param {{[key: string]: string}} scraperHeaders - Custom headers to apply to the web-scraping request URL
   * @param {[key: string]: string} metadata - Optional metadata to attach to the document
   * @returns {Promise<Object>} - The response from the collector API
   */
  async processLink(link = "", scraperHeaders = {}, metadata = {}) {
    if (!link) return false;

    const data = JSON.stringify({
      link,
      scraperHeaders,
      options: this.#attachOptions(),
      metadata: metadata,
    });

    return await this.#fetch(`${this.endpoint}/process-link`, {
      method: "POST",
      headers: this.#protectedHeaders("/process-link", "POST", data),
      body: data,
    })
      .then(async (res) => {
        await this.#throwIfFailed(res, "POST /process-link");
        return res.json();
      })
      .then((res) => res)
      .catch((e) => {
        this.log(e.message);
        return { success: false, reason: e.message, documents: [] };
      });
  }

  /**
   * Process raw text as a document for the collector
   * - Will append the options to the request body
   * @param {string} textContent - The text to process
   * @param {[key: string]: string} metadata - The metadata to process
   * @returns {Promise<Object>} - The response from the collector API
   */
  async processRawText(textContent = "", metadata = {}) {
    const data = JSON.stringify({
      textContent,
      metadata,
      options: this.#attachOptions(),
    });
    return await this.#fetch(`${this.endpoint}/process-raw-text`, {
      method: "POST",
      headers: this.#protectedHeaders("/process-raw-text", "POST", data),
      body: data,
    })
      .then(async (res) => {
        await this.#throwIfFailed(res, "POST /process-raw-text");
        return res.json();
      })
      .then((res) => res)
      .catch((e) => {
        this.log(e.message);
        return { success: false, reason: e.message, documents: [] };
      });
  }

  // We will not ever expose the document processor to the frontend API so instead we relay
  // all requests through the server. You can use this function to directly expose a specific endpoint
  // on the document processor.
  async forwardExtensionRequest({ endpoint, method, body }) {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    return await this.#fetch(`${this.endpoint}${endpoint}`, {
      method,
      body: data,
      headers: this.#protectedHeaders(endpoint, method, data),
      // Extensions do a lot of work, and may take a while to complete so we need to increase the timeout
      // substantially so that they do not show a failure to the user early.
      dispatcher: this.extensionRequestAgent,
    })
      .then(async (res) => {
        await this.#throwIfFailed(res, `${method} ${endpoint}`);
        return res.json();
      })
      .then((res) => res)
      .catch((e) => {
        this.log(e.message);
        return { success: false, data: {}, reason: e.message };
      });
  }

  /**
   * Get the content of a link only in a specific format
   * - Will append the options to the request body
   * @param {string} link - The link to get the content of
   * @param {"text"|"html"} captureAs - The format to capture the content as
   * @returns {Promise<Object>} - The response from the collector API
   */
  async getLinkContent(link = "", captureAs = "text") {
    if (!link) return false;

    const data = JSON.stringify({
      link,
      captureAs,
      options: this.#attachOptions(),
    });
    return await this.#fetch(`${this.endpoint}/util/get-link`, {
      method: "POST",
      headers: this.#protectedHeaders("/util/get-link", "POST", data),
      body: data,
    })
      .then(async (res) => {
        await this.#throwIfFailed(res, "POST /util/get-link");
        return res.json();
      })
      .then((res) => res)
      .catch((e) => {
        this.log(e.message);
        return { success: false, content: null };
      });
  }

  /**
   * Parse a document without processing it
   * - Will append the options to the request body
   * @param {string} filename - The filename of the document to parse
   * @param {Object} parseOptions - Additional options for parsing
   * Absolute paths are resolved and copied into an opaque hotdir handle inside
   * this trusted server process. They are never sent across the Collector API.
   * @returns {Promise<Object>} - The response from the collector API
   */
  async parseDocument(filename = "", parseOptions = {}) {
    if (!filename) return false;
    let sourcePath = parseOptions.absolutePath || null;
    if (parseOptions.absolutePath && !parseOptions.skipFileAccessPolicy) {
      const { validateReadPath } = require("../fileAccessPolicy");
      const validation = await validateReadPath(
        parseOptions.absolutePath,
        parseOptions.fileAccessContext || {}
      );
      if (!validation.allowed) {
        return {
          success: false,
          reason: validation.reason,
          message: validation.message,
          documents: [],
        };
      }
      sourcePath = validation.path;
    }

    let stagedInput = null;
    try {
      stagedInput = sourcePath
        ? this.#copyToOpaqueHotdirHandle(
            sourcePath,
            parseOptions.displayName || filename
          )
        : this.#stageExistingHotdirInput(filename);
      const data = JSON.stringify({
        uploadId: stagedInput.uploadId,
        options: {
          ...this.#attachOptions(),
          displayName: parseOptions.displayName || filename,
        },
      });

      const response = await this.#fetch(`${this.endpoint}/parse`, {
        method: "POST",
        headers: this.#protectedHeaders("/parse", "POST", data),
        body: data,
      });
      await this.#throwIfFailed(response, "POST /parse");
      return await response.json();
    } catch (error) {
      this.log(error.message);
      return { success: false, reason: error.message, documents: [] };
    } finally {
      this.#removeStagedInput(stagedInput);
    }
  }
}

module.exports.CollectorApi = CollectorApi;
