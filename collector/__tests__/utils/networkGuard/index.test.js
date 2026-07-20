const {
  assertSafeDestination,
  isAddressAllowed,
  readResponseBufferLimited,
  readResponseJsonLimited,
  _private,
} = require("../../../utils/networkGuard");

describe("collector network guard", () => {
  const originalAllowlist = process.env.COLLECTOR_PRIVATE_NETWORK_ALLOWLIST;
  const originalGuard = process.env.ATHENA_COLLECTOR_GUARD_V2;

  afterEach(() => {
    _private.resolutionCache.clear();
    if (originalAllowlist === undefined)
      delete process.env.COLLECTOR_PRIVATE_NETWORK_ALLOWLIST;
    else process.env.COLLECTOR_PRIVATE_NETWORK_ALLOWLIST = originalAllowlist;
    if (originalGuard === undefined)
      delete process.env.ATHENA_COLLECTOR_GUARD_V2;
    else process.env.ATHENA_COLLECTOR_GUARD_V2 = originalGuard;
  });

  test.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("rejects non-public address %s", (address) => {
    expect(isAddressAllowed(address, address)).toBe(false);
  });

  it("allows a private address only through an explicit CIDR", () => {
    process.env.COLLECTOR_PRIVATE_NETWORK_ALLOWLIST = "10.20.0.0/16";
    expect(isAddressAllowed("10.20.4.5", "service.internal")).toBe(true);
    expect(isAddressAllowed("10.21.4.5", "service.internal")).toBe(false);
  });

  it("rejects cloud metadata hostnames before DNS", async () => {
    await expect(
      assertSafeDestination(
        "http://metadata.google.internal/computeMetadata/v1"
      )
    ).rejects.toMatchObject({ code: "collector_destination_forbidden" });
  });

  it("rejects literal loopback destinations", async () => {
    await expect(
      assertSafeDestination("http://127.0.0.1/private")
    ).rejects.toMatchObject({ code: "collector_destination_forbidden" });
  });

  it("bounds buffered connector responses before parsing", async () => {
    await expect(
      readResponseBufferLimited(new Response("oversized"), 4)
    ).rejects.toMatchObject({ code: "collector_response_too_large" });

    await expect(
      readResponseJsonLimited(new Response('{"ok":true}'), 32)
    ).resolves.toEqual({ ok: true });
  });

  it("strips credentials and applies browser-compatible redirect methods", () => {
    const redirected = _private.redirectFetchOptions(
      {
        method: "POST",
        body: "secret-body",
        headers: {
          Authorization: "Bearer secret",
          "PRIVATE-TOKEN": "private",
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      },
      303,
      new URL("https://connector.example/start"),
      new URL("https://other.example/next")
    );

    expect(redirected.method).toBe("GET");
    expect(redirected.body).toBeUndefined();
    expect(redirected.headers.get("authorization")).toBeNull();
    expect(redirected.headers.get("private-token")).toBeNull();
    expect(redirected.headers.get("content-type")).toBeNull();
    expect(redirected.headers.get("accept")).toBe("application/json");
  });
});
