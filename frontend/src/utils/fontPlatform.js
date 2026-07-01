export const FONT_PLATFORM_ATTRIBUTE = "data-font-platform";
export const FONT_PLATFORM_APPLE = "apple";
export const FONT_PLATFORM_WINDOWS = "windows";
export const FONT_PLATFORM_WINDOWS_FIREFOX = "windows-firefox";
export const FONT_PLATFORM_CJK_WEBFONT = "cjk-webfont";
export const FONT_LANGUAGE = "zh-CN";

export function detectFontPlatform(navigatorLike = globalThis.navigator) {
  const userAgent = navigatorLike?.userAgent || "";
  const platform = navigatorLike?.platform || "";
  const userAgentDataPlatform = navigatorLike?.userAgentData?.platform || "";
  const maxTouchPoints = Number(navigatorLike?.maxTouchPoints || 0);
  const platformText = `${platform} ${userAgentDataPlatform}`;

  const isApple =
    /mac|iphone|ipad|ipod/i.test(platformText) ||
    /iphone|ipad|ipod/i.test(userAgent) ||
    (platform === "MacIntel" && maxTouchPoints > 1);

  if (isApple) return FONT_PLATFORM_APPLE;

  const isWindows =
    /win/i.test(platformText) || /windows/i.test(userAgent || "");
  const isFirefox = /firefox\//i.test(userAgent);

  if (isWindows && isFirefox) return FONT_PLATFORM_WINDOWS_FIREFOX;
  if (isWindows) return FONT_PLATFORM_WINDOWS;

  return FONT_PLATFORM_CJK_WEBFONT;
}

export function installFontPlatformScope(
  root = globalThis.document?.documentElement,
  navigatorLike = globalThis.navigator
) {
  if (!root?.setAttribute) return null;

  const platform = detectFontPlatform(navigatorLike);
  root.setAttribute("lang", FONT_LANGUAGE);
  root.setAttribute(FONT_PLATFORM_ATTRIBUTE, platform);
  return platform;
}

export function collectFontDiagnostics(
  root = globalThis.document?.documentElement,
  navigatorLike = globalThis.navigator
) {
  const documentRef = root?.ownerDocument || globalThis.document;
  const windowRef = documentRef?.defaultView || globalThis;
  const getComputedStyleRef = windowRef?.getComputedStyle;
  const computedFontFamily = (selector) => {
    const element = documentRef?.querySelector?.(selector);
    if (!element || !getComputedStyleRef) return null;
    return getComputedStyleRef(element).fontFamily || null;
  };

  return {
    language:
      root?.getAttribute?.("lang") || documentRef?.documentElement?.lang,
    platform:
      root?.getAttribute?.(FONT_PLATFORM_ATTRIBUTE) ||
      detectFontPlatform(navigatorLike),
    navigatorPlatform: navigatorLike?.platform || "",
    userAgentDataPlatform: navigatorLike?.userAgentData?.platform || "",
    userAgent: navigatorLike?.userAgent || "",
    athenaNotoSansScAvailable:
      documentRef?.fonts?.check?.('16px "Athena Noto Sans SC"') ?? null,
    computedFontFamilies: {
      body: computedFontFamily("body"),
      chatHistory: computedFontFamily("#chat-history"),
      promptInput: computedFontFamily("#primary-prompt-input"),
    },
  };
}

export function installFontDiagnostics(
  root = globalThis.document?.documentElement,
  navigatorLike = globalThis.navigator
) {
  const documentRef = root?.ownerDocument || globalThis.document;
  const windowRef = documentRef?.defaultView || globalThis;
  const search = windowRef?.location?.search || "";
  const enabled = new URLSearchParams(search).get("debugFonts") === "1";
  if (!enabled) return null;

  const publish = () => {
    const diagnostics = collectFontDiagnostics(root, navigatorLike);
    windowRef.__athenaFontDiagnostics = diagnostics;
    windowRef.console?.info?.("[Athena font diagnostics]", diagnostics);
    return diagnostics;
  };

  const fontsReady = documentRef?.fonts?.ready;
  if (fontsReady?.then) fontsReady.then(publish).catch(() => {});
  return publish();
}
