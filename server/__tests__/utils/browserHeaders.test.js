const {
  buildContentSecurityPolicy,
  setBrowserSecurityHeaders,
} = require("../../utils/security/browserHeaders");

describe("browser security headers", () => {
  it("does not allow inline scripts by default", () => {
    const policy = buildContentSecurityPolicy({
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://athena.example.com",
      ATHENA_CSP_CONNECT_SRC: "https://api.example.com,wss://ws.example.com",
    });

    const scriptDirective = policy
      .split("; ")
      .find((directive) => directive.startsWith("script-src"));
    expect(scriptDirective).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(policy).toContain(
      "connect-src 'self' https://athena.example.com wss://athena.example.com https://api.example.com wss://ws.example.com"
    );
  });

  it("keeps inline styles only as a compatibility default", () => {
    expect(buildContentSecurityPolicy()).toContain(
      "style-src 'self' 'unsafe-inline'"
    );
    expect(buildContentSecurityPolicy({ ATHENA_CSP_STRICT_STYLE: "true" }))
      .toContain("style-src 'self'");
  });

  it("sets runtime browser hardening headers", () => {
    const headers = {};
    const response = {
      removeHeader: jest.fn((name) => delete headers[name.toLowerCase()]),
      setHeader: jest.fn((name, value) => {
        headers[name.toLowerCase()] = value;
      }),
    };

    setBrowserSecurityHeaders(response, {
      PUBLIC_API_URL: "https://api.athena.example",
    });

    expect(response.removeHeader).toHaveBeenCalledWith("X-Powered-By");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("geolocation=()");
    expect(headers["content-security-policy"]).toContain(
      "connect-src 'self' https://api.athena.example wss://api.athena.example"
    );
  });
});
