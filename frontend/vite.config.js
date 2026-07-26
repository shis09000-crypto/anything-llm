/* global console, process */
import { defineConfig } from "vite"
import fs from "fs"
import https from "https"
import { fileURLToPath, URL } from "url"
import postcss from "./postcss.config.js"
import react from "@vitejs/plugin-react"
import dns from "dns"
import { visualizer } from "rollup-plugin-visualizer"

dns.setDefaultResultOrder("verbatim")

function devHttpsOptions() {
  if (process.env.VITE_DEV_HTTPS !== "true") return false

  const keyPath = process.env.VITE_HTTPS_KEY_PATH
  const certPath = process.env.VITE_HTTPS_CERT_PATH
  if (!keyPath || !certPath) return false
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return false

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  }
}

const apiProxyTarget =
  process.env.VITE_DEV_API_PROXY_TARGET ||
  `${
    process.env.VITE_DEV_HTTPS === "false" ||
    process.env.ENABLE_HTTPS === "false"
      ? "http"
      : "https"
  }://localhost:${process.env.SERVER_PORT || "3001"}`
const apiProxyAgent = apiProxyTarget.startsWith("https:")
  ? new https.Agent({ rejectUnauthorized: false })
  : undefined
const apiProxyChangeOrigin =
  process.env.VITE_DEV_API_PROXY_CHANGE_ORIGIN === "true" ||
  (() => {
    try {
      return new URL(apiProxyTarget).hostname === "athenallm.online"
    } catch {
      return false
    }
  })()
const apiProxyTargetUrl = new URL(apiProxyTarget)
const apiProxyRewriteOrigin =
  process.env.VITE_DEV_API_PROXY_REWRITE_ORIGIN !== "false" &&
  apiProxyTargetUrl.hostname === "athenallm.online"

function spaPublicDirectoryRouteGuard() {
  return {
    name: "athena-spa-public-directory-route-guard",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const requestUrl = String(request.url || "/")
        const [pathname, query = ""] = requestUrl.split("?", 2)
        // `public/login/` contains static login assets. Vite otherwise treats
        // the SPA route `/login` as that directory and returns a redirect/500
        // instead of letting React Router render the page.
        if (pathname === "/login") {
          request.url = `/${query ? `?${query}` : ""}`
        }
        next()
      })
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  assetsInclude: [
    "./public/piper/ort-wasm-simd-threaded.wasm",
    "./public/piper/piper_phonemize.wasm",
    "./public/piper/piper_phonemize.data"
  ],
  worker: {
    format: "es"
  },
  server: {
    port: 3000,
    host: "localhost",
    strictPort: true,
    https: devHttpsOptions(),
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: apiProxyChangeOrigin,
        secure: false,
        agent: apiProxyAgent,
        ws: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (!apiProxyRewriteOrigin) return
            proxyReq.setHeader("origin", apiProxyTargetUrl.origin)
            proxyReq.setHeader("referer", `${apiProxyTargetUrl.origin}/`)
          })
          proxy.on("error", (error, _request, response) => {
            console.error(
              `[vite:api-proxy] ${apiProxyTarget} failed: ${error?.message || error}`
            )
            if (
              typeof response?.writeHead !== "function" ||
              response.headersSent ||
              response.writableEnded
            )
              return
            response.writeHead(502, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store"
            })
            response.end(
              JSON.stringify({
                success: false,
                error: "development_api_proxy_unavailable"
              })
            )
          })
        }
      }
    }
  },
  define: {
    "process.env": process.env
  },
  css: {
    postcss
  },
  plugins: [
    spaPublicDirectoryRouteGuard(),
    react(),
    visualizer({
      template: "treemap", // or sunburst
      open: false,
      gzipSize: true,
      brotliSize: true,
      filename: "bundleinspector.html" // will be saved in project's root
    })
  ],
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url))
      },
      {
        process: "process/browser",
        stream: "stream-browserify",
        zlib: "browserify-zlib",
        util: "util",
        find: /^~.+/,
        replacement: (val) => {
          return val.replace(/^~/, "")
        }
      }
    ]
  },
  build: {
    rollupOptions: {
      external: [
        // Reduces transformation time by 50% and we don't even use this variant, so we can ignore.
        /@phosphor-icons\/react\/dist\/ssr/
      ]
    },
    commonjsOptions: {
      transformMixedEsModules: true
    }
  },
  optimizeDeps: {
    include: ["@mintplex-labs/piper-tts-web"],
    esbuildOptions: {
      define: {
        global: "globalThis"
      },
      plugins: []
    }
  }
})
