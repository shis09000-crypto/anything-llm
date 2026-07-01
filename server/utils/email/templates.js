const PRODUCT_NAME = "Athena";
const PRODUCT_TAGLINE = "Knowledge Operating System";
const DEFAULT_LOGO_CID = "athena-email-logo";

const palette = {
  surface: "#F5F5F7",
  card: "#FFFFFF",
  textPrimary: "#0F172A",
  textSecondary: "#64748B",
  textMuted: "#94A3B8",
  border: "#E2E8F0",
  primary: "#0A84FF",
  primaryDark: "#0066D6",
  warningBg: "#FFF7ED",
  warningBorder: "#FED7AA",
  warningText: "#9A3412",
  dangerBg: "#FEF2F2",
  dangerBorder: "#FECACA",
  dangerText: "#DC2626",
  infoBg: "#EFF6FF",
  infoBorder: "#BFDBFE",
  infoText: "#1D4ED8",
  successBg: "#F0FDF4",
  successBorder: "#BBF7D0",
  successText: "#16A34A",
  gold: "#C5A05A",
};

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskedEmail(email = "") {
  const [name = "", domain = ""] = String(email).split("@");
  if (!name || !domain) return "";
  const visible = name.length <= 2 ? name[0] : `${name[0]}${name.slice(-1)}`;
  return `${visible}${"*".repeat(Math.max(name.length - visible.length, 2))}@${domain}`;
}

function normalizeLanguage(language = "") {
  const value = String(language || "")
    .trim()
    .toLowerCase();
  const primary = value.split(",")[0]?.trim() || "";
  if (!primary) return "en";
  if (primary.startsWith("zh")) return "zh";
  return primary.split("-")[0] || "en";
}

function publicAppOrigin() {
  const configured = String(process.env.PUBLIC_APP_URL || "").trim();
  if (!configured) return "";
  try {
    return new URL(configured).origin;
  } catch {
    return configured.replace(/\/+$/, "");
  }
}

function safeUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^cid:[A-Za-z0-9._-]+$/.test(raw)) return raw;
  if (raw.startsWith("mailto:")) return raw;
  try {
    const url = new URL(raw);
    if (["http:", "https:"].includes(url.protocol)) return url.toString();
  } catch {}
  return "";
}

function joinUrl(origin = "", path = "") {
  const base = String(origin || "").replace(/\/+$/, "");
  if (!base) return "";
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function defaultBrandLogoUrl() {
  const explicit = safeUrl(process.env.EMAIL_BRAND_LOGO_URL);
  if (explicit) return explicit;
  return `cid:${DEFAULT_LOGO_CID}`;
}

function footerLinks() {
  const origin = publicAppOrigin();
  return {
    supportUrl:
      safeUrl(process.env.EMAIL_SUPPORT_URL) ||
      safeUrl(process.env.SUPPORT_URL) ||
      "mailto:team@mintplexlabs.com",
    privacyUrl:
      safeUrl(process.env.EMAIL_PRIVACY_URL) ||
      (origin ? joinUrl(origin, "/settings/privacy") : ""),
    termsUrl:
      safeUrl(process.env.EMAIL_TERMS_URL) ||
      (origin ? joinUrl(origin, "/") : ""),
  };
}

function officialDomainLabel() {
  return publicAppOrigin() || "Athena official domain";
}

function textValue(value, fallback = "Unknown") {
  const stringValue = String(value || "").trim();
  return stringValue || fallback;
}

function row({ label, value }) {
  return `
    <tr>
      <td style="padding:8px 0;font-size:13px;line-height:20px;color:${palette.textMuted};white-space:nowrap;">${escapeHtml(label)}</td>
      <td align="right" style="padding:8px 0 8px 16px;font-size:13px;line-height:20px;color:${palette.textPrimary};font-weight:600;">${escapeHtml(value)}</td>
    </tr>`;
}

function header({ brandLogoUrl = defaultBrandLogoUrl() } = {}) {
  const safeLogo = safeUrl(brandLogoUrl);
  const logo = safeLogo
    ? `<img src="${escapeHtml(safeLogo)}" width="36" height="36" alt="${PRODUCT_NAME}" style="display:block;border:0;border-radius:10px;outline:none;text-decoration:none;" />`
    : `<div style="width:36px;height:36px;border-radius:10px;background:${palette.card};border:1px solid ${palette.border};line-height:36px;text-align:center;color:${palette.gold};font-weight:800;font-size:16px;">A</div>`;

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:middle;width:44px;">${logo}</td>
        <td style="vertical-align:middle;padding-left:10px;">
          <div style="font-size:15px;line-height:20px;font-weight:700;color:${palette.textPrimary};">${PRODUCT_NAME}</div>
          <div style="font-size:12px;line-height:18px;color:${palette.textSecondary};">${PRODUCT_TAGLINE}</div>
        </td>
      </tr>
    </table>`;
}

function footer({ locale = "en" } = {}) {
  const language = normalizeLanguage(locale);
  const copy =
    language === "zh"
      ? {
          help: "帮助中心",
          privacy: "隐私政策",
          terms: "服务条款",
          official: "请只在 Athena 官方域名输入验证码：",
          copyright: "Athena。保留所有权利。",
        }
      : {
          help: "Help Center",
          privacy: "Privacy",
          terms: "Terms",
          official:
            "Only enter verification codes on the official Athena domain:",
          copyright: "Athena. All rights reserved.",
        };
  const links = footerLinks();
  const linkStyle = `color:${palette.textSecondary};text-decoration:underline;text-underline-offset:2px;`;
  const linkSeparator = `<span style="color:${palette.textMuted};padding:0 8px;">·</span>`;
  const support = links.supportUrl
    ? `<a href="${escapeHtml(links.supportUrl)}" style="${linkStyle}">${copy.help}</a>`
    : `<span>${copy.help}</span>`;
  const privacy = links.privacyUrl
    ? `<a href="${escapeHtml(links.privacyUrl)}" style="${linkStyle}">${copy.privacy}</a>`
    : `<span>${copy.privacy}</span>`;
  const terms = links.termsUrl
    ? `<a href="${escapeHtml(links.termsUrl)}" style="${linkStyle}">${copy.terms}</a>`
    : `<span>${copy.terms}</span>`;

  return `
    <div style="font-size:12px;line-height:20px;color:${palette.textSecondary};text-align:center;">
      <div style="margin-bottom:8px;">${escapeHtml(copy.official)} <strong style="color:${palette.textPrimary};">${escapeHtml(officialDomainLabel())}</strong></div>
      <div>${support}${linkSeparator}${privacy}${linkSeparator}${terms}</div>
      <div style="margin-top:8px;color:${palette.textMuted};">&copy; ${new Date().getFullYear()} ${copy.copyright}</div>
    </div>`;
}

function notice({ variant = "info", title = "", body = "" } = {}) {
  if (!title && !body) return "";
  const styles = {
    info: {
      bg: palette.infoBg,
      border: palette.infoBorder,
      text: palette.infoText,
    },
    warning: {
      bg: palette.warningBg,
      border: palette.warningBorder,
      text: palette.warningText,
    },
    danger: {
      bg: palette.dangerBg,
      border: palette.dangerBorder,
      text: palette.dangerText,
    },
    success: {
      bg: palette.successBg,
      border: palette.successBorder,
      text: palette.successText,
    },
  };
  const style = styles[variant] || styles.info;
  return `
    <div style="margin-top:24px;border:1px solid ${style.border};background:${style.bg};border-radius:14px;padding:14px 16px;">
      ${
        title
          ? `<div style="font-size:14px;line-height:20px;font-weight:700;color:${style.text};margin-bottom:${body ? "4px" : "0"};">${escapeHtml(title)}</div>`
          : ""
      }
      ${
        body
          ? `<div style="font-size:13px;line-height:20px;color:${style.text};">${escapeHtml(body)}</div>`
          : ""
      }
    </div>`;
}

function infoCard({ rows = [] } = {}) {
  const visibleRows = rows.filter((item) => item?.label && item?.value);
  if (!visibleRows.length) return "";
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;border:1px solid ${palette.border};border-radius:14px;background:#F8FAFC;padding:8px 16px;">
      ${visibleRows.map(row).join("")}
    </table>`;
}

function verificationCode({ code, expiry, locale = "en" }) {
  const language = normalizeLanguage(locale);
  const helper =
    language === "zh"
      ? `${expiry || "验证码 10 分钟内有效"}，请勿转发给任何人。`
      : `${expiry || "This code is valid for 10 minutes"}. Do not forward it to anyone.`;
  return `
    <div style="margin:24px 0 6px;border:1px solid ${palette.border};border-radius:18px;background:#F8FAFC;padding:22px 20px;text-align:center;">
      <div style="font-family:${fontFamily};font-size:32px;line-height:40px;font-weight:800;letter-spacing:8px;color:${palette.textPrimary};">${escapeHtml(code)}</div>
    </div>
    <div style="font-size:13px;line-height:20px;color:${palette.textSecondary};text-align:center;">${escapeHtml(helper)}</div>`;
}

function securityContext({
  locale = "en",
  device = "",
  platform = "",
  location = "",
  ip = "",
  time = "",
  requestId = "",
} = {}) {
  const language = normalizeLanguage(locale);
  const copy =
    language === "zh"
      ? {
          title: "请求信息",
          device: "设备",
          platform: "平台",
          location: "地区",
          ip: "IP",
          time: "时间",
          requestId: "请求 ID",
          unknown: "未识别",
        }
      : {
          title: "Request details",
          device: "Device",
          platform: "Platform",
          location: "Location",
          ip: "IP",
          time: "Time",
          requestId: "Request ID",
          unknown: "Unknown",
        };
  const rows = [
    { label: copy.device, value: textValue(device, copy.unknown) },
    platform ? { label: copy.platform, value: platform } : null,
    location ? { label: copy.location, value: location } : null,
    ip ? { label: copy.ip, value: ip } : null,
    { label: copy.time, value: textValue(time, new Date().toISOString()) },
    requestId ? { label: copy.requestId, value: requestId } : null,
  ].filter(Boolean);

  return `
    <div style="margin-top:24px;">
      <div style="font-size:13px;line-height:20px;font-weight:700;color:${palette.textPrimary};margin-bottom:8px;">${escapeHtml(copy.title)}</div>
      ${infoCard({ rows })}
    </div>`;
}

function ctaButton({ label = "", url = "" } = {}) {
  const href = safeUrl(url);
  if (!label || !href) return "";
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr>
        <td style="border-radius:12px;background:${palette.primary};">
          <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 18px;font-size:14px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px;background:${palette.primary};">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

function layout({
  locale = "en",
  title,
  subtitle = "",
  mainContent = "",
  security = "",
  noticeContent = "",
  cta = "",
  brandLogoUrl = defaultBrandLogoUrl(),
  preheader = "",
}) {
  const safeTitle = escapeHtml(title || PRODUCT_NAME);
  const safeSubtitle = escapeHtml(subtitle || "");
  const resolvedBrandLogoUrl = brandLogoUrl || defaultBrandLogoUrl();
  return `<!doctype html>
<html lang="${escapeHtml(normalizeLanguage(locale))}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${safeTitle}</title>
    <style>
      @media only screen and (max-width: 520px) {
        .athena-shell { padding: 24px 12px !important; }
        .athena-card { padding: 24px 18px !important; border-radius: 18px !important; }
        .athena-title { font-size: 22px !important; line-height: 30px !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:${palette.surface};font-family:${fontFamily};-webkit-text-size-adjust:100%;text-size-adjust:100%;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader || subtitle || title || PRODUCT_NAME)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${palette.surface};">
      <tr>
        <td class="athena-shell" align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
            <tr>
              <td style="padding:0 0 20px 0;">${header({ brandLogoUrl: resolvedBrandLogoUrl })}</td>
            </tr>
            <tr>
              <td class="athena-card" style="background:${palette.card};border:1px solid ${palette.border};border-radius:20px;padding:32px;box-shadow:0 18px 45px rgba(15,23,42,0.08);">
                <h1 class="athena-title" style="margin:0 0 8px;font-size:24px;line-height:32px;color:${palette.textPrimary};font-weight:700;">${safeTitle}</h1>
                ${safeSubtitle ? `<p style="margin:0 0 24px;font-size:15px;line-height:24px;color:${palette.textSecondary};">${safeSubtitle}</p>` : ""}
                ${mainContent}
                ${security}
                ${noticeContent}
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 8px 0;">${footer({ locale })}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

const verificationCopy = {
  zh: {
    bind_email: {
      purpose: "邮箱验证",
      subject: "Athena 邮箱验证码",
      title: "确认你的邮箱",
      subtitle: "使用下面的验证码完成绑定或更换邮箱。",
      expiry: "验证码 10 分钟内有效",
      warningTitle: "安全提醒",
      warningBody:
        "Athena 不会通过邮件索要密码、Passkey 或完整密钥。请只在官方域名输入验证码。",
    },
    password_reset: {
      purpose: "密码重置",
      subject: "Athena 密码重置验证码",
      title: "重置你的密码",
      subtitle: "使用下面的验证码继续密码重置流程。",
      expiry: "验证码 10 分钟内有效",
      warningTitle: "如果这不是你本人操作",
      warningBody: "请忽略本邮件，并尽快检查账号安全和可信设备。",
    },
    register: {
      purpose: "账号注册",
      subject: "Athena 注册验证码",
      title: "完成 Athena 注册",
      subtitle: "使用下面的验证码验证你的邮箱所有权。",
      expiry: "验证码 10 分钟内有效",
      warningTitle: "安全提醒",
      warningBody:
        "请勿将验证码转发给任何人。Athena 只会要求你在官方域名输入验证码。",
    },
  },
  en: {
    bind_email: {
      purpose: "Email verification",
      subject: "Athena Email Verification Code",
      title: "Confirm your email",
      subtitle: "Use the code below to finish binding or changing your email.",
      expiry: "This code is valid for 10 minutes",
      warningTitle: "Security reminder",
      warningBody:
        "Athena will never ask for your password, passkey, or full secrets by email. Only enter this code on the official domain.",
    },
    password_reset: {
      purpose: "Password reset",
      subject: "Athena Password Reset Code",
      title: "Reset your password",
      subtitle: "Use the code below to continue your password reset.",
      expiry: "This code is valid for 10 minutes",
      warningTitle: "If this wasn't you",
      warningBody:
        "Ignore this email and check your account security and trusted devices as soon as possible.",
    },
    register: {
      purpose: "Account registration",
      subject: "Athena Registration Code",
      title: "Complete your Athena registration",
      subtitle: "Use the code below to verify ownership of your email.",
      expiry: "This code is valid for 10 minutes",
      warningTitle: "Security reminder",
      warningBody:
        "Do not forward this code to anyone. Athena only asks you to enter codes on the official domain.",
    },
  },
};

function copyForPurpose({ purpose, locale }) {
  const language = normalizeLanguage(locale);
  const bundle = verificationCopy[language] || verificationCopy.en;
  return bundle[purpose] || bundle.bind_email;
}

function renderVerificationEmail({
  code,
  purpose,
  language = "en",
  securityContext: context = {},
  brandLogoUrl,
} = {}) {
  const locale = normalizeLanguage(language);
  const copy = copyForPurpose({ purpose, locale });
  const html = layout({
    locale,
    title: copy.title,
    subtitle: copy.subtitle,
    preheader: `${copy.purpose}: ${copy.expiry}`,
    brandLogoUrl,
    mainContent: verificationCode({
      code,
      expiry: copy.expiry,
      locale,
    }),
    security: securityContext({ locale, ...context }),
    noticeContent: notice({
      variant: "warning",
      title: copy.warningTitle,
      body: copy.warningBody,
    }),
  });
  const text = [
    copy.title,
    "",
    copy.subtitle,
    "",
    `${copy.purpose}: ${code}`,
    copy.expiry,
    locale === "zh" ? "请勿转发给任何人。" : "Do not forward it to anyone.",
    "",
    `${locale === "zh" ? "官方域名" : "Official domain"}: ${officialDomainLabel()}`,
    `${locale === "zh" ? "设备" : "Device"}: ${textValue(context.device, locale === "zh" ? "未识别" : "Unknown")}`,
    context.platform
      ? `${locale === "zh" ? "平台" : "Platform"}: ${context.platform}`
      : null,
    context.location
      ? `${locale === "zh" ? "地区" : "Location"}: ${context.location}`
      : null,
    context.ip ? `IP: ${context.ip}` : null,
    `${locale === "zh" ? "时间" : "Time"}: ${textValue(context.time, new Date().toISOString())}`,
    "",
    copy.warningBody,
  ]
    .filter(Boolean)
    .join("\n");
  return { subject: copy.subject, text, html };
}

function renderSecurityNotificationEmail({
  subject,
  text,
  language = "en",
  securityContext: context = {},
  variant = "info",
  brandLogoUrl,
} = {}) {
  const locale = normalizeLanguage(language);
  const title =
    subject ||
    (locale === "zh" ? "Athena 安全通知" : "Athena security notification");
  const subtitle =
    locale === "zh"
      ? "这是一封来自 Athena 的账号安全通知。"
      : "This is an account security notification from Athena.";
  const html = layout({
    locale,
    title,
    subtitle,
    preheader: text || subtitle,
    brandLogoUrl,
    mainContent: `<div style="font-size:15px;line-height:24px;color:${palette.textPrimary};white-space:pre-line;">${escapeHtml(text || "")}</div>`,
    security: securityContext({ locale, ...context }),
    noticeContent: notice({
      variant,
      title:
        locale === "zh"
          ? "请确认这是你本人操作"
          : "Please confirm this was you",
      body:
        locale === "zh"
          ? "如果你不认识这次操作，请立即检查账号安全设置。"
          : "If you do not recognize this activity, review your account security settings immediately.",
    }),
  });
  return { subject: title, text: text || title, html };
}

module.exports = {
  DEFAULT_LOGO_CID,
  palette,
  escapeHtml,
  maskedEmail,
  normalizeLanguage,
  publicAppOrigin,
  defaultBrandLogoUrl,
  header,
  footer,
  layout,
  infoCard,
  verificationCode,
  securityContext,
  notice,
  ctaButton,
  renderVerificationEmail,
  renderSecurityNotificationEmail,
  _private: {
    safeUrl,
    officialDomainLabel,
    copyForPurpose,
  },
};
