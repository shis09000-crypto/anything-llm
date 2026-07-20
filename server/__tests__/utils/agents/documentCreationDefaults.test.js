/* global jest, describe, it, expect */
const {
  createFilesAgent,
} = require("../../../utils/agents/aibitat/plugins/create-files");

const CASES = [
  {
    name: "create-text-file",
    input: { filename: "README.md", content: "# Document" },
  },
  {
    name: "create-docx-file",
    input: { filename: "document.docx", content: "# Document" },
  },
  {
    name: "create-pdf-file",
    input: { filename: "document.pdf", content: "# Document" },
  },
];

function setup(subPlugin) {
  let definition = null;
  const aibitat = {
    function: jest.fn((value) => {
      definition = value;
    }),
    handlerProps: { log: jest.fn() },
    introspect: jest.fn(),
    requestToolApproval: jest.fn().mockResolvedValue({
      approved: false,
      message: "rejected",
    }),
    socket: { send: jest.fn() },
  };
  subPlugin.plugin().setup(aibitat);
  return { aibitat, definition };
}

describe("default document creation tools", () => {
  it.each(CASES)(
    "registers $name and requests approval before writing",
    async ({ name, input }) => {
      const subPlugin = createFilesAgent.plugin.find(
        (plugin) => plugin.name === name
      );
      expect(subPlugin).toBeDefined();
      const { aibitat, definition } = setup(subPlugin);
      expect(definition.parameters.required).toEqual(
        expect.arrayContaining(["filename", "content"])
      );

      const result = await definition.handler.call(definition, input);
      expect(result).toBe("rejected");
      expect(aibitat.requestToolApproval).toHaveBeenCalledTimes(1);
      expect(aibitat.socket.send).not.toHaveBeenCalled();
    }
  );
});
