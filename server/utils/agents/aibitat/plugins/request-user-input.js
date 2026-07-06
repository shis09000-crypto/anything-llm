const { lazyDataAccessFacade } = require("../../../dataAccess/lazyFacade");
const SystemSettings = lazyDataAccessFacade("adminSystem");

const REQUEST_USER_INPUT_TOOL_NAME = "request-user-input";
const HARD_MAX_PER_TURN = 3;
const MAX_QUESTION_CHARS = 150;
const MAX_CHOICE_OPTIONS = 3;
const DEFAULT_TIMEOUT_MS = 180_000;
const CHOICE_ONLY_REPAIR_MESSAGE =
  "[request-user-input requires choice questions only. Re-call request-user-input with 1-3 questions where every question has kind='choice' and exactly three non-empty guessed options ordered by recommendation strength. Do not use kind='input'; the UI automatically adds a fourth custom answer field.]";

function truncateUnicode(value = "", maxChars = MAX_QUESTION_CHARS) {
  const chars = Array.from(String(value || "").trim());
  if (chars.length <= maxChars) return chars.join("");
  return chars.slice(0, maxChars).join("");
}

function normalizedAnswerText(answer = {}) {
  if (answer.skipped) return "[user skipped]";
  if (Array.isArray(answer.answer)) return answer.answer.join(", ");
  if (
    answer.answer === null ||
    answer.answer === undefined ||
    answer.answer === ""
  )
    return "[no answer]";
  return String(answer.answer);
}

/**
 * Format a result as a numbered transcript so the LLM can map each answer
 * back to the question it asked.
 */
function formatAnswersForAgent(questions, result) {
  if (result.timedOut)
    return "[no response within the time limit - proceed using your best judgment]";
  if (result.skipped)
    return "[user skipped - proceed using your best judgment]";

  const lines = questions.map((q, i) => {
    const answer = result.answers[i] || { skipped: true };
    return `${i + 1}. Q: ${q.question}\n   A: ${normalizedAnswerText(answer)}`;
  });
  return lines.join("\n");
}

function formatAnswersForPromptTail(questions, result) {
  return `<clarification_answers>\n${formatAnswersForAgent(questions, result)}\n</clarification_answers>`;
}

/**
 * Lazy-load the per-turn cap and timeout from SystemSettings on first call,
 * cache on the aibitat instance, and track how many questions have been asked
 * this turn.
 */
async function ensureState(aibitat) {
  if (aibitat._clarifyState) return aibitat._clarifyState;

  const maxPerTurnRaw = await SystemSettings.getValueOrFallback(
    { label: "agent_clarifying_questions_max_per_turn" },
    String(HARD_MAX_PER_TURN)
  );

  const maxPerTurn = Number(maxPerTurnRaw);

  aibitat._clarifyState = {
    asked: 0,
    maxPerTurn: Number.isFinite(maxPerTurn)
      ? Math.max(1, Math.min(HARD_MAX_PER_TURN, Math.floor(maxPerTurn)))
      : HARD_MAX_PER_TURN,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  return aibitat._clarifyState;
}

function choiceRepairMessage(reason = null) {
  return reason
    ? `${CHOICE_ONLY_REPAIR_MESSAGE} Reason: ${reason}.`
    : CHOICE_ONLY_REPAIR_MESSAGE;
}

/**
 * Validate and normalize a single choice question. Invalid entries reject the
 * whole request so the model retries instead of rendering a partial prompt.
 */
function normalizeChoiceQuestion(raw) {
  if (!raw || typeof raw !== "object")
    return { error: "question must be an object" };
  if (typeof raw.question !== "string" || !raw.question.trim())
    return { error: "question must be a non-empty string" };
  if (raw.kind !== "choice")
    return {
      error: "kind must be 'choice'; free-form input questions are not allowed",
    };

  const options = Array.isArray(raw.options)
    ? raw.options.map((option) => String(option || "").trim()).filter(Boolean)
    : [];
  if (options.length !== MAX_CHOICE_OPTIONS)
    return {
      error: `choice questions must include exactly ${MAX_CHOICE_OPTIONS} non-empty options`,
    };

  return {
    question: {
      kind: "choice",
      question: truncateUnicode(raw.question),
      options,
      optionDescriptions: Array.isArray(raw.optionDescriptions)
        ? raw.optionDescriptions
            .slice(0, MAX_CHOICE_OPTIONS)
            .map((description) => String(description || "").trim())
        : [],
      multiSelect: false,
      allowOther: true,
    },
  };
}

const AskUser = {
  name: REQUEST_USER_INPUT_TOOL_NAME,
  plugin: function () {
    return {
      name: REQUEST_USER_INPUT_TOOL_NAME,
      setup(aibitat) {
        // Skip when the runtime can't actually prompt the user. The websocket
        // plugin attaches requestUserClarification only when a socket is present.
        if (typeof aibitat.requestUserClarification !== "function") return;

        aibitat.function({
          super: aibitat,
          name: REQUEST_USER_INPUT_TOOL_NAME,
          description:
            "Prompt the user with multiple-choice clarification questions via an interactive form. " +
            "This is the ONLY way to ask the user questions - text responses cannot receive replies. " +
            "Call this tool when you need a URL, file path, name, date, preference, or any other detail to proceed. " +
            "Ask at most 3 questions per turn, and keep each question under 150 Unicode characters. " +
            "Every question MUST be kind='choice' with exactly three guessed options: option 1 is your best recommendation, options 2 and 3 are backups. The user will always have a fourth custom answer input after those options. " +
            "The user will see a form and their answers are returned to you.",
          examples: [
            {
              prompt: "Scrape a link for me",
              call: JSON.stringify({
                questions: [
                  {
                    kind: "choice",
                    question: "Which URL would you like me to scrape?",
                    options: [
                      "Use the URL already mentioned in this chat",
                      "Use the currently open browser page",
                      "Use the project documentation URL",
                    ],
                  },
                ],
              }),
            },
            {
              prompt: "Help me write a PRD",
              call: JSON.stringify({
                questions: [
                  {
                    kind: "choice",
                    question: "What is the product or feature?",
                    options: [
                      "New user onboarding",
                      "Team admin controls",
                      "Search and discovery",
                    ],
                  },
                  {
                    kind: "choice",
                    question: "Who are the target users?",
                    options: [
                      "New customers",
                      "Power users",
                      "Internal operators",
                    ],
                  },
                  {
                    kind: "choice",
                    question: "What's the priority?",
                    options: ["P0", "P1", "P2"],
                    optionDescriptions: [
                      "Recommended based on urgency.",
                      "Good fallback if the scope is moderate.",
                      "Use only if this can wait.",
                    ],
                  },
                ],
              }),
            },
          ],
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object",
            properties: {
              questions: {
                type: "array",
                minItems: 1,
                maxItems: HARD_MAX_PER_TURN,
                description:
                  "Array of independent question objects. Batch only when they do not depend on each other.",
                items: {
                  type: "object",
                  required: ["kind", "question", "options"],
                  additionalProperties: false,
                  properties: {
                    kind: {
                      type: "string",
                      enum: ["choice"],
                      description:
                        "Must be 'choice'. The UI adds a fourth custom free-form answer input automatically.",
                    },
                    question: {
                      type: "string",
                      maxLength: MAX_QUESTION_CHARS,
                      description:
                        "The question to show the user. Keep it under 150 Unicode characters.",
                    },
                    options: {
                      type: "array",
                      minItems: MAX_CHOICE_OPTIONS,
                      maxItems: MAX_CHOICE_OPTIONS,
                      items: { type: "string" },
                      description:
                        "Exactly three non-empty model-guessed options ordered by recommendation strength: option 1 is the best recommendation, options 2 and 3 are backups. The UI always adds a custom answer input after these options.",
                    },
                    optionDescriptions: {
                      type: "array",
                      maxItems: MAX_CHOICE_OPTIONS,
                      items: { type: "string" },
                    },
                    multiSelect: { type: "boolean" },
                    allowOther: {
                      type: "boolean",
                      description:
                        "Ignored by the server; custom user input is always allowed.",
                    },
                  },
                },
              },
            },
            required: ["questions"],
            additionalProperties: false,
          },
          handler: async function ({ questions = [] }) {
            if (!Array.isArray(questions) || questions.length < 1)
              return "[ask-user requires a 'questions' array with at least 1 entry]";

            const normalizedResults = questions.map((q) =>
              normalizeChoiceQuestion(q)
            );
            const invalid = normalizedResults.find((result) => result.error);
            if (invalid) return choiceRepairMessage(invalid.error);
            const normalized = normalizedResults.map(
              (result) => result.question
            );

            const state = await ensureState(this.super);
            const remaining = state.maxPerTurn - state.asked;
            if (remaining <= 0) {
              return `[clarification limit of ${state.maxPerTurn} reached for this turn - do not ask again, proceed with best judgment]`;
            }

            const truncated = normalized.slice(0, remaining);
            const truncatedNote =
              truncated.length < normalized.length
                ? ` (truncated from ${normalized.length} to fit the per-turn cap of ${state.maxPerTurn})`
                : "";
            state.asked += truncated.length;

            this.super.introspect(
              `Asking the user ${truncated.length} clarifying question${truncated.length === 1 ? "" : "s"}${truncatedNote}.`
            );
            const result = await this.super.requestUserClarification({
              questions: truncated,
              allowSkip: true,
              timeoutMs: state.timeoutMs,
            });

            const agentTranscript = formatAnswersForAgent(truncated, result);
            this.super.addClarifyingQuestionSurvey({
              questions: truncated,
              result,
            });
            this.super.addClarifyingQuestionPromptTail(
              formatAnswersForPromptTail(truncated, result)
            );

            return agentTranscript + truncatedNote;
          },
        });
      },
    };
  },
};

const requestUserInput = {
  name: REQUEST_USER_INPUT_TOOL_NAME,
  startupConfig: {
    params: {},
  },
  plugin: [AskUser],
};

module.exports = {
  REQUEST_USER_INPUT_TOOL_NAME,
  requestUserInput,
  normalizeChoiceQuestion,
  choiceRepairMessage,
  formatAnswersForAgent,
  formatAnswersForPromptTail,
  HARD_MAX_PER_TURN,
  MAX_QUESTION_CHARS,
  MAX_CHOICE_OPTIONS,
};
