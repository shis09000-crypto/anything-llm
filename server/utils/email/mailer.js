const fs = require("fs");
const nodemailer = require("nodemailer");
const path = require("path");
const {
  DEFAULT_LOGO_CID,
  maskedEmail: templateMaskedEmail,
  normalizeLanguage,
  publicAppOrigin,
  renderSecurityNotificationEmail,
  renderVerificationEmail,
} = require("./templates");

const DEFAULT_LOGO_PATH = path.resolve(__dirname, "assets", "athena-logo.png");

function smtpConfig() {
  const host = process.env.EMAIL_SMTP_HOST;
  const port = Number(process.env.EMAIL_SMTP_PORT || 465);
  const user = process.env.EMAIL_SMTP_USER;
  const pass = process.env.EMAIL_SMTP_PASSWORD;
  const from = process.env.EMAIL_SMTP_FROM || user;
  const secure = String(process.env.EMAIL_SMTP_SECURE ?? "true") === "true";

  return { host, port, user, pass, from, secure };
}

function isConfigured() {
  const { host, port, user, pass, from } = smtpConfig();
  return Boolean(host && port && user && pass && from);
}

function maskedEmail(email = "") {
  return templateMaskedEmail(email);
}

function transporter() {
  const { host, port, user, pass, secure } = smtpConfig();
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

function logoAttachmentFor(html = "", attachments = []) {
  const hasInlineLogo = String(html || "").includes(`cid:${DEFAULT_LOGO_CID}`);
  const alreadyAttached = attachments.some(
    (attachment) => attachment?.cid === DEFAULT_LOGO_CID
  );
  if (!hasInlineLogo || alreadyAttached) return [];

  const logoPath = process.env.EMAIL_BRAND_LOGO_PATH || DEFAULT_LOGO_PATH;
  if (!fs.existsSync(logoPath)) return [];

  return [
    {
      filename: "athena-logo.png",
      path: logoPath,
      cid: DEFAULT_LOGO_CID,
      contentType: "image/png",
      contentDisposition: "inline",
    },
  ];
}

async function sendMail({ to, subject, text, html, attachments = [] }) {
  if (!isConfigured()) throw new Error("email_smtp_not_configured");
  const { from } = smtpConfig();
  const inlineAttachments = logoAttachmentFor(html, attachments);
  const mailAttachments = [...inlineAttachments, ...attachments];
  const payload = { from, to, subject, text, html };
  if (mailAttachments.length) payload.attachments = mailAttachments;
  return await transporter().sendMail(payload);
}

function verificationMessage({
  code,
  purpose,
  language = "en",
  securityContext = {},
  brandLogoUrl = null,
}) {
  return renderVerificationEmail({
    code,
    purpose,
    language,
    securityContext,
    brandLogoUrl,
  });
}

async function sendVerificationCode({
  to,
  code,
  purpose,
  language = "en",
  securityContext = {},
  brandLogoUrl = null,
}) {
  const message = verificationMessage({
    code,
    purpose,
    language,
    securityContext,
    brandLogoUrl,
  });
  return await sendMail({ to, ...message });
}

async function sendSecurityNotification({
  to,
  subject,
  text,
  language = "en",
  securityContext = {},
  variant = "info",
  brandLogoUrl = null,
}) {
  const message = renderSecurityNotificationEmail({
    subject,
    text,
    language,
    securityContext,
    variant,
    brandLogoUrl,
  });
  return await sendMail({ to, ...message });
}

module.exports = {
  isConfigured,
  maskedEmail,
  sendMail,
  sendVerificationCode,
  sendSecurityNotification,
  smtpConfig,
  normalizeLanguage,
  publicAppOrigin,
  verificationMessage,
  _private: {
    DEFAULT_LOGO_PATH,
    logoAttachmentFor,
  },
};
