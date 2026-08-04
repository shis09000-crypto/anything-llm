/* global describe, test, expect */

const {
  createProviderAdapter,
} = require("../../utils/AiProviders/providerAdapter");
const {
  wrapWithModelGateway,
} = require("../../utils/modelGateway/remoteProvider");
const {
  wrapWithResponsesRuntime,
} = require("../../utils/responsesRuntime/chatAdapter");

class PrivateMethodProvider {
  #format(value) {
    return `prompt:${value}`;
  }

  constructor(model) {
    this.className = "PrivateMethodProvider";
    this.model = model;
  }

  constructPrompt(value) {
    return this.#format(value);
  }
}

describe("remote provider adapter private method receiver", () => {
  test("binds inherited provider methods to the branded delegate", () => {
    const delegate = new PrivateMethodProvider("deepseek-v4-pro");
    const adapter = createProviderAdapter(delegate, { remote: true });

    expect(adapter.constructPrompt("ok")).toBe("prompt:ok");
    expect(adapter.remote).toBe(true);
    expect(adapter).toBeInstanceOf(PrivateMethodProvider);
  });

  test("preserves branded prompt construction on the Model Gateway path", () => {
    const delegate = new PrivateMethodProvider("deepseek-v4-pro");
    const adapter = wrapWithModelGateway(delegate, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      env: {
        ATHENA_RUNTIME_ROLE: "chat-runtime",
        ATHENA_MODEL_GATEWAY_CUTOVER: "true",
        ATHENA_MODEL_GATEWAY_URL: "http://model-gateway.test",
      },
    });

    expect(adapter.constructPrompt("pro")).toBe("prompt:pro");
    expect(adapter.modelGateway).toBe(true);
  });

  test("preserves branded prompt construction on the Responses path", () => {
    const delegate = new PrivateMethodProvider("deepseek-v4-flash");
    const adapter = wrapWithResponsesRuntime(delegate, {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      env: {
        ATHENA_RUNTIME_ROLE: "chat-runtime",
        ATHENA_RESPONSES_RUNTIME_CUTOVER: "true",
        ATHENA_RESPONSES_RUNTIME_URL: "http://responses-runtime.test",
      },
    });

    expect(adapter.constructPrompt("flash")).toBe("prompt:flash");
    expect(adapter.responsesRuntime).toBe(true);
  });
});
