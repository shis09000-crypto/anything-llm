const {
  closeStoppedAgentSocket,
} = require("../../utils/agents/aibitat/plugins/websocket");

describe("agent websocket pause state", () => {
  it("marks an intentional stop before closing the durable bridge", () => {
    const socket = {
      __clientStopped: false,
      close: jest.fn(),
    };

    closeStoppedAgentSocket(socket);

    expect(socket.__clientStopped).toBe(true);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });
});
