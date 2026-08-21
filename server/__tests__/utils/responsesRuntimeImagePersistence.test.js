const {
  stateInputWithoutDynamicTime,
} = require("../../utils/responsesRuntime/runtime");
const { providerInput } = require("../../utils/responsesRuntime/modelClient");

describe("Responses image persistence boundary", () => {
  test("removes turn-scoped Base64 and provider file ids from durable state", () => {
    const state = stateInputWithoutDynamicTime([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "compare" },
          {
            type: "input_image",
            file_id: "file-provider-secret",
            athena_asset_id: "asset-1",
          },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [
          { type: "input_text", text: "captured" },
          {
            type: "input_image",
            image_url: "data:image/jpeg;base64,ZmFrZQ==",
          },
        ],
      },
    ]);
    expect(JSON.stringify(state)).not.toContain("base64");
    expect(JSON.stringify(state)).not.toContain("file-provider-secret");
    expect(state[0].content[1]).toEqual({
      type: "input_image",
      athena_asset_id: "asset-1",
    });
    expect(state[1].output).toEqual([{ type: "input_text", text: "captured" }]);
  });

  test("keeps Base64 for the live provider call but strips internal asset ids", () => {
    const input = providerInput([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_image",
            file_id: "file-1",
            athena_asset_id: "asset-1",
          },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [
          {
            type: "input_image",
            image_url: "data:image/jpeg;base64,ZmFrZQ==",
          },
        ],
      },
    ]);
    expect(input[0].content[0]).toEqual({
      type: "input_image",
      file_id: "file-1",
    });
    expect(input[1].output[0].image_url).toContain("data:image/jpeg;base64,");
  });
});
