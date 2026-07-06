const CURRENT_DATETIME_TAG = "current_datetime";
const CURRENT_DATETIME_BLOCK_REGEX = new RegExp(
  `\\n*\\s*<${CURRENT_DATETIME_TAG}>[\\s\\S]*?<\\/${CURRENT_DATETIME_TAG}>\\s*$`
);

function configuredPromptTimeZone() {
  const timeZone =
    process.env.PROMPT_CONTEXT_TIMEZONE ||
    process.env.SYSTEM_PROMPT_TIMEZONE ||
    process.env.TZ ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "Asia/Shanghai";

  try {
    Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "Asia/Shanghai";
  }
}

function dateTimeParts(
  date = new Date(),
  timeZone = configuredPromptTimeZone()
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function currentDateTimePromptBlock({
  now = new Date(),
  timeZone = configuredPromptTimeZone(),
} = {}) {
  const { date, time } = dateTimeParts(now, timeZone);
  return [
    `<${CURRENT_DATETIME_TAG}>`,
    "Use this as the current date and time for this request.",
    `Current date: ${date}`,
    `Current time: ${time}`,
    `Time zone: ${timeZone}`,
    `ISO timestamp: ${now.toISOString()}`,
    `</${CURRENT_DATETIME_TAG}>`,
  ].join("\n");
}

function stripCurrentDateTimePromptBlock(text = "") {
  if (typeof text !== "string") return text;
  return text.replace(CURRENT_DATETIME_BLOCK_REGEX, "").trimEnd();
}

function appendCurrentDateTimeToPrompt(text = "", options = {}) {
  const base = stripCurrentDateTimePromptBlock(String(text));
  const block = currentDateTimePromptBlock(options);
  return base ? `${base}\n\n${block}` : block;
}

function appendCurrentDateTimeToLastUserMessage(messages = [], options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const nextMessages = [...messages];
  for (let i = nextMessages.length - 1; i >= 0; i--) {
    const message = nextMessages[i];
    if (message?.role !== "user" || typeof message.content !== "string")
      continue;

    nextMessages[i] = {
      ...message,
      content: appendCurrentDateTimeToPrompt(message.content, options),
    };
    break;
  }

  return nextMessages;
}

module.exports = {
  CURRENT_DATETIME_TAG,
  appendCurrentDateTimeToLastUserMessage,
  appendCurrentDateTimeToPrompt,
  configuredPromptTimeZone,
  currentDateTimePromptBlock,
  stripCurrentDateTimePromptBlock,
};
