const {
  appendCurrentDateTimeToLastUserMessage,
  appendCurrentDateTimeToPrompt,
  currentDateTimePromptBlock,
  stripCurrentDateTimePromptBlock,
} = require("../../../utils/chats/currentDateTimeContext");

describe("currentDateTimeContext", () => {
  const now = new Date("2026-06-17T06:30:45.000Z");
  const timeZone = "Asia/Shanghai";

  it("formats the current date/time block with the configured timezone", () => {
    const block = currentDateTimePromptBlock({ now, timeZone });

    expect(block).toContain("<current_datetime>");
    expect(block).toContain("Current date: 2026-06-17");
    expect(block).toContain("Current time: 14:30:45");
    expect(block).toContain("Time zone: Asia/Shanghai");
    expect(block).toContain("ISO timestamp: 2026-06-17T06:30:45.000Z");
    expect(block).toContain("</current_datetime>");
  });

  it("appends the current date/time to the bottom of the prompt without duplicating", () => {
    const first = appendCurrentDateTimeToPrompt("Hello", { now, timeZone });
    const second = appendCurrentDateTimeToPrompt(first, { now, timeZone });

    expect(second.startsWith("Hello\n\n<current_datetime>")).toBe(true);
    expect(second.match(/<current_datetime>/g)).toHaveLength(1);
  });

  it("strips an existing current date/time block from the prompt tail", () => {
    const prompt = appendCurrentDateTimeToPrompt("Original question", {
      now,
      timeZone,
    });

    expect(stripCurrentDateTimePromptBlock(prompt)).toBe("Original question");
  });

  it("appends the current date/time to the last string user message", () => {
    const messages = appendCurrentDateTimeToLastUserMessage(
      [
        { role: "system", content: "System" },
        { role: "user", content: "Earlier user" },
        { role: "assistant", content: "Assistant" },
        { role: "user", content: "Latest user" },
      ],
      { now, timeZone }
    );

    expect(messages[1].content).toBe("Earlier user");
    expect(messages[3].content).toContain("Latest user");
    expect(messages[3].content).toContain("<current_datetime>");
  });
});
