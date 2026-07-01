describe("Athena email templates", () => {
  let templates;

  beforeEach(() => {
    jest.resetModules();
    process.env.PUBLIC_APP_URL = "https://athena.example.com";
    templates = require("../../utils/email/templates");
  });

  afterEach(() => {
    delete process.env.PUBLIC_APP_URL;
    delete process.env.EMAIL_BRAND_LOGO_URL;
    delete process.env.EMAIL_SUPPORT_URL;
    delete process.env.EMAIL_PRIVACY_URL;
    delete process.env.EMAIL_TERMS_URL;
  });

  test("renders verification email with Athena layout, logo, code, and security context", () => {
    const message = templates.renderVerificationEmail({
      code: "123456",
      purpose: "password_reset",
      language: "zh",
      securityContext: {
        device: "desktop",
        platform: "web",
        location: "Shanghai",
        ip: "127.0.0.1",
        time: "2026-07-01T08:00:00.000Z",
        requestId: "req_123",
      },
    });

    expect(message.subject).toBe("Athena 密码重置验证码");
    expect(message.text).toContain("123456");
    expect(message.text).toContain("127.0.0.1");
    expect(message.html).toContain("Knowledge Operating System");
    expect(message.html).toContain("cid:athena-email-logo");
    expect(message.html).toContain("123456");
    expect(message.html).toContain("Shanghai");
    expect(message.html).toContain("请只在 Athena 官方域名输入验证码");
  });

  test("escapes dynamic content in html while preserving text fallback", () => {
    const message = templates.renderSecurityNotificationEmail({
      subject: "Security <check>",
      text: "Hello <script>alert(1)</script>",
      securityContext: {
        device: 'Chrome "Desktop"',
        ip: "10.0.0.1",
      },
    });

    expect(message.text).toContain("<script>alert(1)</script>");
    expect(message.html).toContain("Security &lt;check&gt;");
    expect(message.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(message.html).toContain("Chrome &quot;Desktop&quot;");
    expect(message.html).not.toContain("<script>alert(1)</script>");
  });

  test("verification emails do not train users to click login links", () => {
    const message = templates.renderVerificationEmail({
      code: "123456",
      purpose: "register",
      language: "en",
    });

    expect(message.html).not.toMatch(/bit\.ly|tinyurl|login|magic link/i);
    expect(message.text).not.toMatch(/bit\.ly|tinyurl|magic link/i);
  });

  test("header can use an explicit public logo url when configured", () => {
    process.env.EMAIL_BRAND_LOGO_URL = "https://athena.example.com/brand.png";
    const freshTemplates = require("../../utils/email/templates");
    const html = freshTemplates.header();

    expect(html).toContain("https://athena.example.com/brand.png");
    expect(html).toContain("<img");
    expect(html).toContain("Athena");
  });

  test("header falls back to text mark when an unsafe logo url is provided", () => {
    const html = templates.header({ brandLogoUrl: "javascript:alert(1)" });

    expect(html).toContain(">A</div>");
    expect(html).toContain("Athena");
    expect(html).not.toContain("<img");
  });
});
