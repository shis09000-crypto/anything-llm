const { v4 } = require("uuid");
const {
  PuppeteerWebBaseLoader,
} = require("langchain/document_loaders/web/puppeteer");
const { writeToServerDocuments } = require("../../utils/files");
const { tokenizeString } = require("../../utils/tokenizer");
const { default: slugify } = require("slugify");
const {
  returnResult,
  determineContentType,
  processAsFile,
} = require("../helpers");
const {
  loadYouTubeTranscript,
} = require("../../utils/extensions/YoutubeTranscript");
const RuntimeSettings = require("../../utils/runtimeSettings");
const { htmlToMarkdown } = require("../helpers/htmlToMarkdown");
const { redactUrl } = require("../../utils/security/redaction");
const {
  assertSafeDestination,
  readResponseTextLimited,
  safeFetch,
} = require("../../utils/networkGuard");
const { currentTaskSignal } = require("../../utils/taskContext");

const MAX_PAGE_BYTES = 25 * 1_024 * 1_024;

/**
 * Scrape a generic URL and return the content in the specified format
 * @param {Object} config - The configuration object
 * @param {string} config.link - The URL to scrape
 * @param {('html' | 'text')} config.captureAs - The format to capture the page content as. Default is 'text'
 * @param {{[key: string]: string}} config.scraperHeaders - Custom headers to use when making the request
 * @param {{[key: string]: string}} config.metadata - Metadata to use when creating the document
 * @param {boolean} config.saveAsDocument - Whether to save the content as a document. Default is true
 * @returns {Promise<Object>} - The content of the page
 */
async function scrapeGenericUrl({
  link,
  captureAs = "text",
  scraperHeaders = {},
  metadata = {},
  saveAsDocument = true,
}) {
  /** @type {'web' | 'file' | 'youtube'} */
  const redactedLink = redactUrl(link);
  console.log(`-- Working URL ${redactedLink} => (captureAs: ${captureAs}) --`);
  let { contentType, processVia } = await determineContentType(link);
  console.log(`-- URL determined to be ${contentType} (${processVia}) --`);

  /**
   * When the content is a file or a YouTube video, we can use the existing processing functions
   * These are self-contained and will return the correct response based on the saveAsDocument flag already
   * so we can return the content immediately.
   */
  if (processVia === "file")
    return await processAsFile({ uri: link, saveAsDocument });
  else if (processVia === "youtube")
    return await loadYouTubeTranscript(
      { url: link },
      { parseOnly: saveAsDocument === false }
    );

  // Otherwise, assume the content is a webpage and scrape the content from the webpage
  const content = await getPageContent({
    link,
    captureAs,
    headers: scraperHeaders,
  });
  if (!content || !content.length) {
    console.error(`Resulting URL content was empty at ${redactedLink}.`);
    return returnResult({
      success: false,
      reason: `No URL content found at ${redactedLink}.`,
      documents: [],
      content: null,
      saveAsDocument,
    });
  }

  // If the captureAs is text, return the content as a string immediately
  // so that we dont save the content as a document
  if (!saveAsDocument)
    return returnResult({
      success: true,
      content,
      saveAsDocument,
    });

  // Save the content as a document from the URL
  const url = new URL(link);
  const decodedPathname = decodeURIComponent(url.pathname);
  const filename = `${url.hostname}${decodedPathname.replace(/\//g, "_")}`;
  const data = {
    id: v4(),
    url: "file://" + slugify(filename) + ".html",
    title: metadata.title || slugify(filename) + ".html",
    docAuthor: metadata.docAuthor || "no author found",
    description: metadata.description || "No description found.",
    docSource: metadata.docSource || "URL link uploaded by the user.",
    chunkSource: `link://${redactedLink}`,
    published: new Date().toLocaleString(),
    wordCount: content.split(" ").length,
    pageContent: content,
    token_count_estimate: tokenizeString(content),
  };

  const document = writeToServerDocuments({
    data,
    filename: `url-${slugify(filename)}-${data.id}`,
  });
  console.log(
    `[SUCCESS]: URL ${redactedLink} converted & ready for embedding.\n`
  );
  return { success: true, reason: null, documents: [document] };
}

/**
 * Validate the headers object
 * - Keys & Values must be strings and not empty
 * - Assemble a new object with only the valid keys and values
 * @param {{[key: string]: string}} headers - The headers object to validate
 * @returns {{[key: string]: string}} - The validated headers object
 */
function validatedHeaders(headers = {}) {
  try {
    if (Object.keys(headers).length === 0) return {};
    let validHeaders = {};
    for (const key of Object.keys(headers)) {
      if (!key?.trim()) continue;
      if (typeof headers[key] !== "string" || !headers[key]?.trim()) continue;
      validHeaders[key] = headers[key].trim();
    }
    return validHeaders;
  } catch (error) {
    console.error("Error validating headers", error);
    return {};
  }
}

/**
 * Get the content of a page
 * @param {Object} config - The configuration object
 * @param {string} config.link - The URL to get the content of
 * @param {('html' | 'text')} config.captureAs - The format to capture the page content as. Default is 'text'
 * @param {{[key: string]: string}} config.headers - Custom headers to use when making the request
 * @returns {Promise<string>} - The content of the page
 */
async function getPageContent({ link, captureAs = "text", headers = {} }) {
  let browser = null;
  let blockedDestination = null;
  try {
    const runtimeSettings = new RuntimeSettings();

    /** @type {import('puppeteer').PuppeteerLaunchOptions} */
    let launchConfig = { headless: "new" };

    /* On MacOS 15.1, the headless=new option causes the browser to crash immediately.
     * It is not clear why this is the case, but it is reproducible. Since AnythinglLM
     * in production runs in a container, we can disable headless mode to workaround the issue for development purposes.
     *
     * This may show a popup window when scraping a page in development mode.
     * This is expected behavior if seen in development mode on MacOS 15+
     */
    if (
      process.platform === "darwin" &&
      process.env.NODE_ENV === "development"
    ) {
      console.log(
        "Darwin Development Mode: Disabling headless mode to prevent Chromium from crashing."
      );
      launchConfig.headless = "false";
    }

    const { launch } = await PuppeteerWebBaseLoader.imports();
    browser = await launch({
      headless: launchConfig.headless,
      defaultViewport: null,
      ignoreDefaultArgs: ["--disable-extensions"],
      ignoreHTTPSErrors:
        process.env.NODE_ENV !== "production" &&
        process.env.COLLECTOR_ALLOW_INSECURE_TLS === "true",
      args: runtimeSettings.get("browserLaunchArgs"),
    });
    const page = await browser.newPage();
    const overrideHeaders = validatedHeaders(headers);
    if (Object.keys(overrideHeaders).length > 0)
      await page.setExtraHTTPHeaders(overrideHeaders);
    await page.setRequestInterception(true);
    page.on("request", async (interceptedRequest) => {
      const requestUrl = interceptedRequest.url();
      try {
        const protocol = new URL(requestUrl).protocol;
        if (["data:", "blob:"].includes(protocol)) {
          await interceptedRequest.continue();
          return;
        }
        await assertSafeDestination(requestUrl);
        await interceptedRequest.continue();
      } catch (error) {
        if (error?.code === "collector_destination_forbidden")
          blockedDestination = error;
        await interceptedRequest.abort("blockedbyclient").catch(() => null);
      }
    });
    const signal = currentTaskSignal();
    const abortBrowser = () => browser?.close().catch(() => null);
    signal?.addEventListener("abort", abortBrowser, { once: true });
    try {
      await page.goto(link, {
        timeout: 180000,
        waitUntil: "networkidle2",
      });
      const innerHTML = await page.evaluate(
        () => document.documentElement.innerHTML
      );
      if (Buffer.byteLength(innerHTML, "utf8") > MAX_PAGE_BYTES)
        throw new Error("Page content exceeds the 25 MiB limit.");
      return captureAs === "html" ? innerHTML : htmlToMarkdown(innerHTML, link);
    } finally {
      signal?.removeEventListener("abort", abortBrowser);
      await browser.close().catch(() => null);
      browser = null;
    }
  } catch (error) {
    await browser?.close().catch(() => null);
    if (blockedDestination) throw blockedDestination;
    if (error?.code === "collector_destination_forbidden") throw error;
    console.error(
      "getPageContent failed to be fetched by puppeteer - falling back to fetch!",
      error
    );
  }

  try {
    const response = await safeFetch(link, {
      method: "GET",
      headers: {
        "Content-Type": "text/plain",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)",
        ...validatedHeaders(headers),
      },
      signal: currentTaskSignal(),
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const pageText = await readResponseTextLimited(response, MAX_PAGE_BYTES);
    return captureAs === "html" ? pageText : htmlToMarkdown(pageText, link);
  } catch (error) {
    if (error?.code === "collector_destination_forbidden") throw error;
    console.error("getPageContent failed to be fetched by any method.", error);
  }

  return null;
}

module.exports = {
  scrapeGenericUrl,
};
