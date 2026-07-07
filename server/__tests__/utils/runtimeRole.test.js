const {
  apiOnlyMode,
  backgroundInlineEnabled,
  envFlag,
  runtimeRole,
} = require("../../utils/runtimeRole");

function withEnv(patch, run) {
  const previous = { ...process.env };
  Object.assign(process.env, patch);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return run();
  } finally {
    process.env = previous;
  }
}

describe("runtime role helpers", () => {
  test("defaults to monolith runtime", () => {
    withEnv(
      { ATHENA_RUNTIME_ROLE: undefined, ATHENA_API_ONLY: undefined },
      () => {
        expect(runtimeRole()).toBe("monolith");
        expect(apiOnlyMode()).toBe(false);
        expect(backgroundInlineEnabled()).toBe(true);
      }
    );
  });

  test("api role enables API-only mode", () => {
    withEnv({ ATHENA_RUNTIME_ROLE: "api" }, () => {
      expect(runtimeRole()).toBe("api");
      expect(apiOnlyMode()).toBe(true);
      expect(backgroundInlineEnabled()).toBe(false);
    });
  });

  test("ATHENA_API_ONLY enables API-only mode without changing role", () => {
    withEnv({ ATHENA_RUNTIME_ROLE: undefined, ATHENA_API_ONLY: "true" }, () => {
      expect(runtimeRole()).toBe("monolith");
      expect(apiOnlyMode()).toBe(true);
      expect(backgroundInlineEnabled()).toBe(true);
    });
  });

  test("ATHENA_BACKGROUND_INLINE overrides runtime role default", () => {
    withEnv(
      { ATHENA_RUNTIME_ROLE: "api", ATHENA_BACKGROUND_INLINE: "true" },
      () => {
        expect(backgroundInlineEnabled()).toBe(true);
      }
    );
    withEnv(
      { ATHENA_RUNTIME_ROLE: "monolith", ATHENA_BACKGROUND_INLINE: "false" },
      () => {
        expect(backgroundInlineEnabled()).toBe(false);
      }
    );
  });

  test("envFlag recognizes explicit false values", () => {
    withEnv({ ATHENA_COLLECTOR_INLINE: "false" }, () => {
      expect(envFlag("ATHENA_COLLECTOR_INLINE", true)).toBe(false);
    });
  });
});
