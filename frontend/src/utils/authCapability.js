import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

const DEFAULT_CAPABILITY = {
  platform: "unknown",
  browser: "unknown",
  supportsWebAuthn: false,
  showPasskey: false,
};

export function detectAuthCapability() {
  if (typeof navigator === "undefined") return DEFAULT_CAPABILITY;

  return classifyAuthCapability({
    userAgent: navigator.userAgent || "",
    platform: navigator.platform || "",
    maxTouchPoints: navigator.maxTouchPoints || 0,
    userAgentData: navigator.userAgentData || null,
    supportsWebAuthn: browserSupportsWebAuthn(),
  });
}

export function classifyAuthCapability({
  userAgent = "",
  platform = "",
  maxTouchPoints = 0,
  userAgentData = null,
  supportsWebAuthn = false,
} = {}) {
  const ua = String(userAgent || "");
  const platformText = getPlatformText(userAgentData, platform);
  const browser = detectBrowser({ userAgent: ua, userAgentData });
  const detectedPlatform = detectPlatform({
    userAgent: ua,
    platform: platformText,
    maxTouchPoints,
  });
  const isAppleCapability =
    detectedPlatform === "apple" || browser === "safari";
  const isChromeCapability = browser === "chrome";
  const showPasskey =
    Boolean(supportsWebAuthn) && (isAppleCapability || isChromeCapability);

  return {
    platform: detectedPlatform,
    browser,
    supportsWebAuthn: Boolean(supportsWebAuthn),
    showPasskey,
  };
}

export function passkeyCapabilityDescription(capability) {
  if (!capability?.showPasskey) {
    return "当前浏览器不支持通行密钥。";
  }

  if (capability.platform === "apple" || capability.browser === "safari") {
    return "可使用 Face ID、Touch ID 或设备密码安全登录。";
  }

  return "可使用浏览器或设备支持的通行密钥安全登录。";
}

function getPlatformText(userAgentData, platform) {
  return (
    userAgentData?.platform || userAgentData?.mobilePlatform || platform || ""
  );
}

function detectPlatform({ userAgent, platform, maxTouchPoints }) {
  const ua = userAgent.toLowerCase();
  const platformText = String(platform || "").toLowerCase();
  const isIPadDesktopMode =
    platformText === "macintel" &&
    Number(maxTouchPoints || 0) > 1 &&
    /safari|mobile/.test(ua);

  if (
    /mac|iphone|ipad|ipod/.test(platformText) ||
    /iphone|ipad|ipod|mac os x|macintosh/.test(ua) ||
    isIPadDesktopMode
  ) {
    return "apple";
  }

  if (/android/.test(platformText) || /android/.test(ua)) return "android";
  if (/win/.test(platformText) || /windows/.test(ua)) return "windows";
  return "unknown";
}

function detectBrowser({ userAgent, userAgentData }) {
  const ua = String(userAgent || "");
  const brands = Array.isArray(userAgentData?.brands)
    ? userAgentData.brands
    : [];
  const highEntropyBrands = Array.isArray(userAgentData?.fullVersionList)
    ? userAgentData.fullVersionList
    : [];
  const brandText = [...brands, ...highEntropyBrands]
    .map((brand) => brand?.brand || "")
    .join(" ");
  const source = `${brandText} ${ua}`;
  const sourceLower = source.toLowerCase();

  if (DOMESTIC_BROWSER_PATTERNS.some((pattern) => pattern.test(source))) {
    return "domestic";
  }

  if (
    /\b(edg|edge|edga|edgios)\//i.test(ua) ||
    /microsoft edge/i.test(source)
  ) {
    return "edge";
  }

  if (/firefox|fxios/i.test(source)) return "firefox";

  if (
    /google chrome/i.test(brandText) ||
    /\bchrome\//i.test(ua) ||
    /\bcrios\//i.test(ua)
  ) {
    if (!/\bchromium\//i.test(ua) && !/chromium/i.test(brandText)) {
      return "chrome";
    }
    if (/google chrome/i.test(brandText)) return "chrome";
  }

  if (
    /version\/[\d.]+/i.test(ua) &&
    /safari/i.test(ua) &&
    !/chrome|crios|chromium|android|edg|firefox|fxios|opr|opera/i.test(
      sourceLower
    )
  ) {
    return "safari";
  }

  return "unknown";
}

const DOMESTIC_BROWSER_PATTERNS = [
  /360se/i,
  /360ee/i,
  /qihoo/i,
  /qihu/i,
  /qhbrowser/i,
  /qqbrowser/i,
  /mqqbrowser/i,
  /sogou/i,
  /metasr/i,
  /2345/i,
  /mb2345browser/i,
  /lbbrowser/i,
  /liebaofast/i,
  /maxthon/i,
  /ubrowser/i,
  /ucbrowser/i,
  /baidubrowser/i,
  /huawei/i,
  /huaweibrowser/i,
  /miuibrowser/i,
  /heytapbrowser/i,
  /oppobrowser/i,
  /vivobrowser/i,
  /quark/i,
];
