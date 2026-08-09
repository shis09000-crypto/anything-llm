const {
  appendCurrentDateTimeToLastUserMessage,
  appendCurrentDateTimeToPrompt,
  configuredPromptTimeZone,
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
    expect(block).toContain("UTC offset: UTC+08:00");
    expect(block).not.toContain("ISO timestamp");
    expect(block).toContain("</current_datetime>");
  });

  it("uses the browser timezone before the deployment default", () => {
    const previous = process.env.PROMPT_CONTEXT_TIMEZONE;
    process.env.PROMPT_CONTEXT_TIMEZONE = "Asia/Shanghai";
    expect(configuredPromptTimeZone("America/New_York")).toBe(
      "America/New_York"
    );
    if (previous === undefined) delete process.env.PROMPT_CONTEXT_TIMEZONE;
    else process.env.PROMPT_CONTEXT_TIMEZONE = previous;
  });

  it("never falls back to the container timezone", () => {
    const previousPrompt = process.env.PROMPT_CONTEXT_TIMEZONE;
    const previousSystem = process.env.SYSTEM_PROMPT_TIMEZONE;
    const previousTz = process.env.TZ;
    delete process.env.PROMPT_CONTEXT_TIMEZONE;
    delete process.env.SYSTEM_PROMPT_TIMEZONE;
    process.env.TZ = "UTC";
    expect(configuredPromptTimeZone()).toBe("Asia/Shanghai");
    if (previousPrompt === undefined)
      delete process.env.PROMPT_CONTEXT_TIMEZONE;
    else process.env.PROMPT_CONTEXT_TIMEZONE = previousPrompt;
    if (previousSystem === undefined) delete process.env.SYSTEM_PROMPT_TIMEZONE;
    else process.env.SYSTEM_PROMPT_TIMEZONE = previousSystem;
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("uses the local calendar day across a UTC date boundary", () => {
    const block = currentDateTimePromptBlock({
      now: new Date("2026-08-09T16:30:00.000Z"),
      timeZone: "Asia/Shanghai",
    });
    expect(block).toContain("Current date: 2026-08-10");
    expect(block).toContain("Current time: 00:30:00");
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
