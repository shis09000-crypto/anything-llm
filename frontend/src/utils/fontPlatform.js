export const FONT_PLATFORM_ATTRIBUTE = "data-font-platform";
export const FONT_PLATFORM_APPLE = "apple";
export const FONT_PLATFORM_CJK_WEBFONT = "cjk-webfont";

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

  return isApple ? FONT_PLATFORM_APPLE : FONT_PLATFORM_CJK_WEBFONT;
}

export function installFontPlatformScope(
  root = globalThis.document?.documentElement,
  navigatorLike = globalThis.navigator
) {
  if (!root?.setAttribute) return null;

  const platform = detectFontPlatform(navigatorLike);
  root.setAttribute(FONT_PLATFORM_ATTRIBUTE, platform);
  return platform;
}
