/**
 * @typedef MetaTagDefinition
 * @property {('link'|'meta')} tag - the type of meta tag element
 * @property {{string:string}|null} props - the inner key/values of a meta tag
 * @property {string|null} content - Text content to be injected between tags. If null self-closing.
 */
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const DEFAULT_PAGE_TITLE = "Athena | 知识操作系统";
const DEFAULT_FAVICON_PATH = "/athena-mark.svg";
const LEGACY_FAVICON_HOSTS = new Set(["116.204.132.44"]);

/**
 * This class serves the default index.html page that is not present when built in production.
 * and therefore this class should not be called when in development mode since it is unused.
 * All this class does is basically emulate SSR for the meta-tag generation of the root index page.
 * Since we are an SPA, we can just render the primary page and the known entrypoints for the index.{js,css}
 * we can always start at the right place and dynamically load in lazy-loaded as we typically normally would
 * and we dont have any of the overhead that would normally come with having the rewrite the whole app in next or something.
 * Lastly, this class is singleton, so once instantiate the same reference is shared for as long as the server is alive.
 * the main function is `.generate()` which will return the index HTML. These settings are stored in the #customConfig
 * static property and will not be reloaded until the page is loaded AND #customConfig is explicitly null. So anytime a setting
 * for meta-props is updated you should get this singleton class and call `.clearConfig` so the next page load will show the new props.
 */
class MetaGenerator {
  name = "MetaGenerator";

  /** @type {MetaGenerator|null} */
  static _instance = null;

  /** @type {MetaTagDefinition[]|null} */
  #customConfig = null;

  #defaultManifest = {
    name: DEFAULT_PAGE_TITLE,
    short_name: "Athena",
    display: "standalone",
    orientation: "portrait",
    start_url: "/",
    icons: [
      {
        src: DEFAULT_FAVICON_PATH,
        sizes: "any",
      },
    ],
  };

  #defaultFrontendEntryTags = `
            <script type="module" crossorigin src="/index.js"></script>
            <link rel="stylesheet" href="/index.css">`;

  constructor() {
    if (MetaGenerator._instance) return MetaGenerator._instance;
    MetaGenerator._instance = this;
  }

  #log(text, ...args) {
    console.log(`\x1b[36m[${this.name}]\x1b[0m ${text}`, ...args);
  }

  #defaultMeta() {
    return [
      {
        tag: "link",
        props: {
          rel: "shortcut icon",
          type: "image/svg+xml",
          href: DEFAULT_FAVICON_PATH,
        },
        content: null,
      },
      {
        tag: "title",
        props: null,
        content: DEFAULT_PAGE_TITLE,
      },

      {
        tag: "meta",
        props: {
          name: "title",
          content: DEFAULT_PAGE_TITLE,
        },
      },
      {
        tag: "meta",
        props: {
          name: "description",
          content: DEFAULT_PAGE_TITLE,
        },
      },

      // <!-- Facebook -->
      { tag: "meta", props: { property: "og:type", content: "website" } },
      {
        tag: "meta",
        props: { property: "og:url", content: "https://anythingllm.com" },
      },
      {
        tag: "meta",
        props: {
          property: "og:title",
          content: DEFAULT_PAGE_TITLE,
        },
      },
      {
        tag: "meta",
        props: {
          property: "og:description",
          content: DEFAULT_PAGE_TITLE,
        },
      },
      {
        tag: "meta",
        props: {
          property: "og:image",
          content:
            "https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/master/images/promo.png",
        },
      },

      // <!-- Twitter -->
      {
        tag: "meta",
        props: { property: "twitter:card", content: "summary_large_image" },
      },
      {
        tag: "meta",
        props: { property: "twitter:url", content: "https://anythingllm.com" },
      },
      {
        tag: "meta",
        props: {
          property: "twitter:title",
          content: DEFAULT_PAGE_TITLE,
        },
      },
      {
        tag: "meta",
        props: {
          property: "twitter:description",
          content: DEFAULT_PAGE_TITLE,
        },
      },
      {
        tag: "meta",
        props: {
          property: "twitter:image",
          content:
            "https://raw.githubusercontent.com/Mintplex-Labs/anything-llm/master/images/promo.png",
        },
      },

      { tag: "link", props: { rel: "icon", href: DEFAULT_FAVICON_PATH } },
      {
        tag: "link",
        props: { rel: "apple-touch-icon", href: DEFAULT_FAVICON_PATH },
      },

      // PWA specific tags
      {
        tag: "meta",
        props: { name: "mobile-web-app-capable", content: "yes" },
      },
      {
        tag: "meta",
        props: { name: "apple-mobile-web-app-capable", content: "yes" },
      },
      {
        tag: "meta",
        props: {
          name: "apple-mobile-web-app-status-bar-style",
          content: "black-translucent",
        },
      },
      { tag: "link", props: { rel: "manifest", href: "/manifest.json" } },
    ];
  }

  /**
   * Assembles Meta tags as one large string
   * @param {MetaTagDefinition[]} tagArray
   * @returns {string}
   */
  #assembleMeta() {
    const output = [];
    for (const tag of this.#customConfig) {
      let htmlString;
      htmlString = `<${tag.tag}`;

      if (tag.props !== null) {
        htmlString += " ";
        for (const [key, value] of Object.entries(tag.props))
          htmlString += `${key}="${value}" `;
      }

      if (tag.content) {
        htmlString += `>${tag.content}</${tag.tag}>`;
      } else {
        htmlString += `>`;
      }
      output.push(htmlString);
    }
    return output.join("\n");
  }

  #validUrl(faviconUrl = null) {
    if (!faviconUrl) return DEFAULT_FAVICON_PATH;
    const value = String(faviconUrl).trim();
    if (value.startsWith("/") && !value.startsWith("//")) return value;
    try {
      const url = new URL(value);
      if (LEGACY_FAVICON_HOSTS.has(url.hostname)) return DEFAULT_FAVICON_PATH;
      return url.toString();
    } catch {
      return DEFAULT_FAVICON_PATH;
    }
  }

  #iconType(faviconUrl = null) {
    const value = String(faviconUrl || "").toLowerCase();
    if (value.endsWith(".svg")) return "image/svg+xml";
    if (value.endsWith(".ico")) return "image/x-icon";
    if (value.endsWith(".png")) return "image/png";
    return undefined;
  }

  #iconProps(rel, faviconUrl = null) {
    const props = { rel, href: this.#validUrl(faviconUrl) };
    const type = this.#iconType(props.href);
    if (type) props.type = type;
    return props;
  }

  #frontendEntryTags() {
    try {
      const indexPath = path.resolve(__dirname, "../../public/_index.html");
      const $ = cheerio.load(fs.readFileSync(indexPath, "utf8"));
      const tags = [];

      $(
        "link[rel='modulepreload'][href], script[src], link[rel='stylesheet'][href]"
      ).each((_, element) => tags.push($.html(element)));

      return tags.length ? tags.join("\n") : this.#defaultFrontendEntryTags;
    } catch (error) {
      this.#log(`failed to read frontend entry tags: ${error.message}`);
      return this.#defaultFrontendEntryTags;
    }
  }

  async #fetchConfg() {
    this.#log(`fetching custom meta tag settings...`);
    const { SystemSettings } = require("../../models/systemSettings");
    const customTitle = await SystemSettings.getValueOrFallback(
      { label: "meta_page_title" },
      null
    );
    const faviconURL = await SystemSettings.getValueOrFallback(
      { label: "meta_page_favicon" },
      null
    );

    // If nothing defined - assume defaults.
    if (customTitle === null && faviconURL === null) {
      this.#customConfig = this.#defaultMeta();
    } else {
      // When custom settings exist, include all default meta tags but override specific ones
      this.#customConfig = this.#defaultMeta().map((tag) => {
        // Override favicon link
        if (
          tag.tag === "link" &&
          ["icon", "shortcut icon"].includes(tag.props?.rel)
        ) {
          return {
            tag: "link",
            props: this.#iconProps(tag.props.rel, faviconURL),
          };
        }
        // Override page title
        if (tag.tag === "title") {
          return {
            tag: "title",
            props: null,
            content: customTitle ?? DEFAULT_PAGE_TITLE,
          };
        }
        // Override meta title
        if (tag.tag === "meta" && tag.props?.name === "title") {
          return {
            tag: "meta",
            props: {
              name: "title",
              content: customTitle ?? DEFAULT_PAGE_TITLE,
            },
          };
        }
        // Override og:title
        if (tag.tag === "meta" && tag.props?.property === "og:title") {
          return {
            tag: "meta",
            props: {
              property: "og:title",
              content: customTitle ?? DEFAULT_PAGE_TITLE,
            },
          };
        }
        // Override twitter:title
        if (tag.tag === "meta" && tag.props?.property === "twitter:title") {
          return {
            tag: "meta",
            props: {
              property: "twitter:title",
              content: customTitle ?? DEFAULT_PAGE_TITLE,
            },
          };
        }
        // Override apple-touch-icon if custom favicon is set
        if (
          tag.tag === "link" &&
          tag.props?.rel === "apple-touch-icon" &&
          faviconURL
        ) {
          return {
            tag: "link",
            props: {
              rel: "apple-touch-icon",
              href: this.#validUrl(faviconURL),
              ...(this.#iconType(faviconURL)
                ? { type: this.#iconType(faviconURL) }
                : {}),
            },
          };
        }
        // Return original tag for everything else (including PWA tags)
        return tag;
      });
    }

    return this.#customConfig;
  }

  /**
   * Clears the current config so it can be refetched on the server for next render.
   */
  clearConfig() {
    this.#customConfig = null;
  }

  /**
   *
   * @param {import('express').Response} response
   * @param {number} code
   */
  async generate(response, code = 200) {
    if (this.#customConfig === null) await this.#fetchConfg();
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response.status(code).send(`
       <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            ${this.#assembleMeta()}
            ${this.#frontendEntryTags()}
          </head>
          <body>
            <div id="root" class="h-screen"></div>
          </body>
        </html>`);
  }

  /**
   * Generates the manifest.json file for the PWA application on the fly.
   * @param {import('express').Response} response
   * @param {number} code
   */
  async generateManifest(response) {
    try {
      const { SystemSettings } = require("../../models/systemSettings");
      const manifestName = await SystemSettings.getValueOrFallback(
        { label: "meta_page_title" },
        DEFAULT_PAGE_TITLE
      );
      const faviconURL = await SystemSettings.getValueOrFallback(
        { label: "meta_page_favicon" },
        null
      );

      const iconUrl = this.#validUrl(faviconURL);

      const manifest = {
        name: manifestName,
        short_name: manifestName,
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          {
            src: iconUrl,
            sizes: "any",
          },
        ],
      };

      response.type("application/json").status(200).send(manifest).end();
    } catch (error) {
      this.#log(`error generating manifest: ${error.message}`, error);
      response
        .type("application/json")
        .status(200)
        .send(this.#defaultManifest)
        .end();
    }
  }
}

module.exports.MetaGenerator = MetaGenerator;
