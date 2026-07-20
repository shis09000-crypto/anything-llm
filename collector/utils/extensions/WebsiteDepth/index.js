const { v4 } = require("uuid");
const { default: slugify } = require("slugify");
const { parse } = require("node-html-parser");
const { writeToServerDocuments, documentsFolder } = require("../../files");
const { tokenizeString } = require("../../tokenizer");
const { scrapeGenericUrl } = require("../../../processLink/convert/generic");
const path = require("path");
const fs = require("fs");
const { redactUrl } = require("../../security/redaction");

async function discoverLinks(startUrl, maxDepth = 1, maxLinks = 20) {
  const baseUrl = new URL(startUrl);
  const discoveredLinks = new Set([startUrl]);
  let queue = [[startUrl, 0]]; // [url, currentDepth]
  const scrapedUrls = new Set();

  for (let currentDepth = 0; currentDepth < maxDepth; currentDepth++) {
    const levelSize = queue.length;
    const nextQueue = [];

    for (let i = 0; i < levelSize && discoveredLinks.size < maxLinks; i++) {
      const [currentUrl, urlDepth] = queue[i];

      if (!scrapedUrls.has(currentUrl)) {
        scrapedUrls.add(currentUrl);
        const newLinks = await getPageLinks(currentUrl, baseUrl);

        for (const link of newLinks) {
          if (!discoveredLinks.has(link) && discoveredLinks.size < maxLinks) {
            discoveredLinks.add(link);
            if (urlDepth + 1 < maxDepth) {
              nextQueue.push([link, urlDepth + 1]);
            }
          }
        }
      }
    }

    queue = nextQueue;
    if (queue.length === 0 || discoveredLinks.size >= maxLinks) break;
  }

  return Array.from(discoveredLinks);
}

async function getPageLinks(url, baseUrl) {
  try {
    const result = await scrapeGenericUrl({
      link: url,
      captureAs: "html",
      saveAsDocument: false,
    });
    if (!result?.success || !result.content) return [];
    const html = result.content;
    const links = extractLinks(html, baseUrl);
    return links;
  } catch (error) {
    console.error(`Failed to get page links from ${redactUrl(url)}.`, error);
    return [];
  }
}

function extractLinks(html, baseUrl) {
  const root = parse(html);
  const links = root.querySelectorAll("a");
  const extractedLinks = new Set();

  for (const link of links) {
    const href = link.getAttribute("href");
    if (href) {
      const absoluteUrl = new URL(href, baseUrl.href).href;
      if (
        absoluteUrl.startsWith(
          baseUrl.origin + baseUrl.pathname.split("/").slice(0, -1).join("/")
        )
      ) {
        extractedLinks.add(absoluteUrl);
      }
    }
  }

  return Array.from(extractedLinks);
}

async function bulkScrapePages(links, outFolderPath) {
  const scrapedData = [];

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const redactedLink = redactUrl(link);
    console.log(`Scraping ${i + 1}/${links.length}: ${redactedLink}`);

    try {
      const result = await scrapeGenericUrl({
        link,
        captureAs: "text",
        saveAsDocument: false,
      });
      const content = result?.success ? result.content : null;

      if (!content?.length) {
        console.warn(`Empty content for ${redactedLink}. Skipping.`);
        continue;
      }

      const url = new URL(link);
      const decodedPathname = decodeURIComponent(url.pathname);
      const filename = `${url.hostname}${decodedPathname.replace(/\//g, "_")}`;

      const data = {
        id: v4(),
        url: "file://" + slugify(filename) + ".html",
        title: slugify(filename) + ".html",
        docAuthor: "no author found",
        description: "No description found.",
        docSource: "URL link uploaded by the user.",
        chunkSource: `link://${redactedLink}`,
        published: new Date().toLocaleString(),
        wordCount: content.split(" ").length,
        pageContent: content,
        token_count_estimate: tokenizeString(content),
      };

      writeToServerDocuments({
        data,
        filename: data.title,
        destinationOverride: outFolderPath,
      });
      scrapedData.push(data);

      console.log(`Successfully scraped ${redactedLink}.`);
    } catch (error) {
      console.error(`Failed to scrape ${redactedLink}.`, error);
    }
  }

  return scrapedData;
}

async function websiteScraper(startUrl, depth = 1, maxLinks = 20) {
  const websiteName = new URL(startUrl).hostname;
  const outFolder = slugify(
    `${slugify(websiteName)}-${v4().slice(0, 4)}`
  ).toLowerCase();
  const outFolderPath = path.resolve(documentsFolder, outFolder);
  console.log("Discovering links...");
  const linksToScrape = await discoverLinks(startUrl, depth, maxLinks);
  console.log(`Found ${linksToScrape.length} links to scrape.`);

  if (!fs.existsSync(outFolderPath))
    fs.mkdirSync(outFolderPath, { recursive: true });
  console.log("Starting bulk scraping...");
  const scrapedData = await bulkScrapePages(linksToScrape, outFolderPath);
  console.log(`Scraped ${scrapedData.length} pages.`);

  return scrapedData;
}

module.exports = websiteScraper;
