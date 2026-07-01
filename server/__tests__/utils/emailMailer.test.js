const mockSendMail = jest.fn().mockResolvedValue({ messageId: "test-message" });

jest.mock("nodemailer", () => ({
  createTransport: jest.fn(() => ({
    sendMail: mockSendMail,
  })),
}));

describe("Athena email mailer", () => {
  let mailer;

  beforeEach(() => {
    jest.resetModules();
    mockSendMail.mockClear();
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_SMTP_PORT = "465";
    process.env.EMAIL_SMTP_USER = "athena@example.com";
    process.env.EMAIL_SMTP_PASSWORD = "test-password";
    process.env.EMAIL_SMTP_FROM = "Athena <athena@example.com>";
    process.env.EMAIL_SMTP_SECURE = "true";
    process.env.PUBLIC_APP_URL = "https://athena.example.com";
    mailer = require("../../utils/email/mailer");
  });

  afterEach(() => {
    delete process.env.EMAIL_SMTP_HOST;
    delete process.env.EMAIL_SMTP_PORT;
    delete process.env.EMAIL_SMTP_USER;
    delete process.env.EMAIL_SMTP_PASSWORD;
    delete process.env.EMAIL_SMTP_FROM;
    delete process.env.EMAIL_SMTP_SECURE;
    delete process.env.EMAIL_BRAND_LOGO_PATH;
    delete process.env.PUBLIC_APP_URL;
  });

  test("attaches the default Athena logo inline when template references the logo cid", async () => {
    await mailer.sendVerificationCode({
      to: "user@example.com",
      code: "123456",
      purpose: "register",
      language: "zh",
    });

    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const payload = mockSendMail.mock.calls[0][0];

    expect(payload.html).toContain("cid:athena-email-logo");
    expect(payload.attachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cid: "athena-email-logo",
          filename: "athena-logo.png",
          contentType: "image/png",
          contentDisposition: "inline",
        }),
      ])
    );
  });

  test("does not duplicate caller-provided logo attachments", async () => {
    await mailer.sendMail({
      to: "user@example.com",
      subject: "Test",
      text: "Test",
      html: '<img src="cid:athena-email-logo" alt="Athena" />',
      attachments: [
        {
          filename: "custom.png",
          content: Buffer.from("custom"),
          cid: "athena-email-logo",
        },
      ],
    });

    const payload = mockSendMail.mock.calls[0][0];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("custom.png");
  });
});
