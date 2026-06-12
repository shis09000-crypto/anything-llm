const nodemailer = require("nodemailer");

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
  const [name = "", domain = ""] = String(email).split("@");
  if (!name || !domain) return "";
  const visible = name.length <= 2 ? name[0] : `${name[0]}${name.slice(-1)}`;
  return `${visible}${"*".repeat(Math.max(name.length - visible.length, 2))}@${domain}`;
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

function normalizeLanguage(language = "") {
  const value = String(language || "")
    .trim()
    .toLowerCase();
  const primary = value.split(",")[0]?.trim() || "";
  if (!primary) return "en";
  if (primary.startsWith("zh")) return "zh";
  return primary.split("-")[0] || "en";
}

const verificationLocaleCopy = {
  zh: {
    bindEmail: {
      purpose: "绑定或更换邮箱",
      subject: "Athena 邮箱验证码",
      bodyLabel: "你的 Athena 绑定或更换邮箱验证码是：",
      expiry: "验证码 10 分钟内有效，请勿转发给他人。",
      caution: "如果这不是你本人操作，请忽略本邮件，并尽快检查账号安全。",
    },
    passwordReset: {
      purpose: "重置密码",
      subject: "Athena 密码重置验证码",
      bodyLabel: "你的 Athena 重置密码验证码是：",
      expiry: "验证码 10 分钟内有效，请勿转发给他人。",
      caution: "如果这不是你本人操作，请忽略本邮件，并尽快检查账号安全。",
    },
  },
  en: {
    bindEmail: {
      purpose: "email binding or change",
      subject: "Athena Email Verification Code",
      bodyLabel: "Your Athena email binding or change verification code is:",
      expiry: "This code is valid for 10 minutes. Do not forward it to anyone.",
      caution:
        "If this wasn't you, please ignore this email and check account security right away.",
    },
    passwordReset: {
      purpose: "password reset",
      subject: "Athena Password Reset Verification Code",
      bodyLabel: "Your Athena password reset verification code is:",
      expiry: "This code is valid for 10 minutes. Do not forward it to anyone.",
      caution:
        "If this wasn't you, please ignore this email and check account security right away.",
    },
  },
};

function getVerificationCopy({ purpose, language = "en" }) {
  const locale = normalizeLanguage(language);
  const copyBundle =
    verificationLocaleCopy[locale] || verificationLocaleCopy.en;
  return purpose === "password_reset"
    ? copyBundle.passwordReset
    : copyBundle.bindEmail;
}

async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) throw new Error("email_smtp_not_configured");
  const { from } = smtpConfig();
  return await transporter().sendMail({ from, to, subject, text, html });
}

function verificationMessage({ code, purpose, language = "en" }) {
  const copy = getVerificationCopy({ purpose, language });
  const text = [
    `${copy.bodyLabel} ${code}`,
    "",
    copy.expiry,
    copy.caution,
  ].join("\n");
  const html = [
    `<p>${copy.bodyLabel}</p>`,
    `<p style="font-size:24px;font-weight:700;letter-spacing:6px;">${code}</p>`,
    `<p>${copy.expiry}</p>`,
    `<p>${copy.caution}</p>`,
  ].join("");
  return { subject: copy.subject, text, html };
}

async function sendVerificationCode({ to, code, purpose, language = "en" }) {
  const message = verificationMessage({ code, purpose, language });
  return await sendMail({ to, ...message });
}

async function sendSecurityNotification({ to, subject, text }) {
  return await sendMail({
    to,
    subject,
    text,
    html: `<p>${String(text).replace(/\n/g, "<br />")}</p>`,
  });
}

module.exports = {
  isConfigured,
  maskedEmail,
  sendMail,
  sendVerificationCode,
  sendSecurityNotification,
  smtpConfig,
  normalizeLanguage,
};
