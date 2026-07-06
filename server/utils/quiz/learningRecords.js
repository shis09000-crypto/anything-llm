const { lazyDataAccessFacade } = require("../dataAccess/lazyFacade");
const QuizData = lazyDataAccessFacade("quiz");
const quizDb = QuizData.db;
const { safeJsonParse } = require("../http");

let tablesReady = false;

function json(value, fallback = "[]") {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return fallback;
  }
}

function cacheUserKey(user = null) {
  return user?.id ? `user:${user.id}` : "anonymous";
}

async function ensureColumn(tableName, columnName, definition) {
  const columns = await quizDb.$queryRawUnsafe(
    `PRAGMA table_info("${tableName}")`
  );
  if (columns.some((column) => column.name === columnName)) return;
  await quizDb.$executeRawUnsafe(
    `ALTER TABLE "${tableName}" ADD COLUMN ${definition}`
  );
}

async function ensureQuizLearningTables() {
  if (tablesReady) return;
  await quizDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_quiz_attempts" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "userId" INTEGER,
      "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
      "quizId" TEXT NOT NULL,
      "quizChatId" INTEGER NOT NULL,
      "topic" TEXT,
      "keywordsJson" TEXT NOT NULL DEFAULT '[]',
      "difficulty" TEXT,
      "totalQuestions" INTEGER NOT NULL DEFAULT 0,
      "completedQuestions" INTEGER NOT NULL DEFAULT 0,
      "score" REAL,
      "accuracy" REAL,
      "analysis" TEXT,
      "questionResultsReliable" INTEGER NOT NULL DEFAULT 1,
      "questionResultsParseError" TEXT,
      "submittedAt" DATETIME,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await quizDb.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_attempts_workspaceId_cacheUserKey_quizChatId_key"
    ON "workspace_quiz_attempts"("workspaceId", "cacheUserKey", "quizChatId");
  `);
  await quizDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_quiz_question_results" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "attemptId" INTEGER NOT NULL,
      "questionId" TEXT NOT NULL,
      "questionType" TEXT NOT NULL,
      "difficulty" TEXT,
      "question" TEXT NOT NULL,
      "optionsJson" TEXT NOT NULL DEFAULT '[]',
      "userAnswerJson" TEXT,
      "correctAnswerJson" TEXT,
      "isCorrect" INTEGER,
      "score" REAL,
      "analysis" TEXT,
      "mistakeReason" TEXT,
      "weakConceptsJson" TEXT NOT NULL DEFAULT '[]',
      "sourceRefsJson" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await quizDb.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_question_results_attemptId_questionId_key"
    ON "workspace_quiz_question_results"("attemptId", "questionId");
  `);
  await quizDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_quiz_wrong_questions" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "userId" INTEGER,
      "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
      "attemptId" INTEGER NOT NULL,
      "questionResultId" INTEGER NOT NULL,
      "questionId" TEXT NOT NULL,
      "questionType" TEXT NOT NULL,
      "topic" TEXT,
      "question" TEXT NOT NULL,
      "optionsJson" TEXT NOT NULL DEFAULT '[]',
      "userAnswerJson" TEXT,
      "correctAnswerJson" TEXT,
      "analysis" TEXT,
      "mistakeReason" TEXT,
      "weakConceptsJson" TEXT NOT NULL DEFAULT '[]',
      "sourceRefsJson" TEXT NOT NULL DEFAULT '[]',
      "reviewCount" INTEGER NOT NULL DEFAULT 0,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await quizDb.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_wrong_questions_workspaceId_cacheUserKey_questionResultId_key"
    ON "workspace_quiz_wrong_questions"("workspaceId", "cacheUserKey", "questionResultId");
  `);
  await quizDb.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "workspace_quiz_favorite_questions" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "workspaceId" INTEGER NOT NULL,
      "userId" INTEGER,
      "cacheUserKey" TEXT NOT NULL DEFAULT 'anonymous',
      "quizId" TEXT NOT NULL,
      "quizChatId" INTEGER NOT NULL,
      "attemptId" INTEGER,
      "questionResultId" INTEGER,
      "questionId" TEXT NOT NULL,
      "questionType" TEXT NOT NULL,
      "topic" TEXT,
      "difficulty" TEXT,
      "question" TEXT NOT NULL,
      "optionsJson" TEXT NOT NULL DEFAULT '[]',
      "correctAnswerJson" TEXT,
      "userAnswerJson" TEXT,
      "analysis" TEXT,
      "sourceRefsJson" TEXT NOT NULL DEFAULT '[]',
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await quizDb.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_favorite_questions_workspaceId_cacheUserKey_quizId_questionId_key"
    ON "workspace_quiz_favorite_questions"("workspaceId", "cacheUserKey", "quizId", "questionId");
  `);
  await ensureColumn(
    "workspace_quiz_attempts",
    "questionResultsReliable",
    `"questionResultsReliable" INTEGER NOT NULL DEFAULT 1`
  );
  await ensureColumn(
    "workspace_quiz_attempts",
    "questionResultsParseError",
    `"questionResultsParseError" TEXT`
  );
  tablesReady = true;
}

function normalizeQuestionResult(result = {}, question = {}, answers = {}) {
  const sourceRefs = result.sourceRefs || question.sourceRefs || [];
  return {
    questionId: String(result.questionId || question.id),
    questionType: result.questionType || question.type,
    difficulty: result.difficulty || question.difficulty || null,
    question: result.question || question.question || "",
    options: result.options || question.options || [],
    userAnswer:
      result.userAnswer !== undefined
        ? result.userAnswer
        : answers[question.id],
    correctAnswer:
      result.correctAnswer !== undefined
        ? result.correctAnswer
        : question.correctAnswer,
    isCorrect:
      result.isCorrect === true
        ? true
        : result.isCorrect === false
          ? false
          : null,
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : null,
    analysis: result.analysis || result.explanation || "",
    mistakeReason: result.mistakeReason || "",
    weakConcepts: Array.isArray(result.weakConcepts) ? result.weakConcepts : [],
    sourceRefs,
  };
}

function publicQuestionResult(record = {}) {
  return {
    id: record.id,
    questionResultId: record.id,
    attemptId: record.attemptId,
    questionId: record.questionId,
    questionType: record.questionType,
    difficulty: record.difficulty,
    question: record.question,
    options: safeJsonParse(record.optionsJson, []),
    userAnswer: safeJsonParse(record.userAnswerJson, null),
    correctAnswer: safeJsonParse(record.correctAnswerJson, null),
    isCorrect:
      record.isCorrect === null || record.isCorrect === undefined
        ? null
        : Number(record.isCorrect) === 1,
    score: record.score,
    analysis: record.analysis,
    mistakeReason: record.mistakeReason,
    weakConcepts: safeJsonParse(record.weakConceptsJson, []),
    sourceRefs: safeJsonParse(record.sourceRefsJson, []),
  };
}

async function upsertAttemptAndQuestionResults({
  workspace,
  user = null,
  quiz,
  answers = {},
  analysis = "",
  structuredResults = [],
  questionResultsReliable = true,
  questionResultsParseError = null,
}) {
  await ensureQuizLearningTables();
  const userKey = cacheUserKey(user);
  const quizChatId = Number(quiz.chatId || quiz.id);
  const submittedAt = new Date().toISOString();
  const normalized = (quiz.questions || []).map((question) =>
    normalizeQuestionResult(
      structuredResults.find((item) => item.questionId === question.id) || {},
      question,
      answers
    )
  );
  const graded = normalized.filter((item) => item.isCorrect !== null);
  const correctCount = graded.filter((item) => item.isCorrect).length;
  const score = questionResultsReliable
    ? normalized.reduce(
        (sum, item) =>
          sum +
          (Number.isFinite(Number(item.score))
            ? Number(item.score)
            : item.isCorrect
              ? 1
              : 0),
        0
      )
    : null;
  const accuracy =
    questionResultsReliable && graded.length > 0
      ? correctCount / graded.length
      : null;

  await quizDb.$executeRawUnsafe(
    `INSERT INTO "workspace_quiz_attempts"
      ("workspaceId","userId","cacheUserKey","quizId","quizChatId","topic","keywordsJson","difficulty","totalQuestions","completedQuestions","score","accuracy","analysis","questionResultsReliable","questionResultsParseError","submittedAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT("workspaceId","cacheUserKey","quizChatId") DO UPDATE SET
      "quizId"=excluded."quizId",
      "topic"=excluded."topic",
      "keywordsJson"=excluded."keywordsJson",
      "difficulty"=excluded."difficulty",
      "totalQuestions"=excluded."totalQuestions",
      "completedQuestions"=excluded."completedQuestions",
      "score"=excluded."score",
      "accuracy"=excluded."accuracy",
      "analysis"=excluded."analysis",
      "questionResultsReliable"=excluded."questionResultsReliable",
      "questionResultsParseError"=excluded."questionResultsParseError",
      "submittedAt"=excluded."submittedAt",
      "updatedAt"=CURRENT_TIMESTAMP`,
    workspace.id,
    user?.id || null,
    userKey,
    String(quiz.id),
    quizChatId,
    quiz.topic || quiz.plan?.topic || null,
    json(quiz.plan?.keywords || []),
    quiz.plan?.difficulty || null,
    quiz.expectedTotalQuestions || normalized.length,
    normalized.length,
    score,
    accuracy,
    analysis,
    questionResultsReliable ? 1 : 0,
    questionResultsParseError,
    submittedAt
  );
  const [attempt] = await quizDb.$queryRawUnsafe(
    `SELECT * FROM "workspace_quiz_attempts" WHERE "workspaceId" = ? AND "cacheUserKey" = ? AND "quizChatId" = ? LIMIT 1`,
    workspace.id,
    userKey,
    quizChatId
  );

  for (const item of normalized) {
    await quizDb.$executeRawUnsafe(
      `INSERT INTO "workspace_quiz_question_results"
        ("attemptId","questionId","questionType","difficulty","question","optionsJson","userAnswerJson","correctAnswerJson","isCorrect","score","analysis","mistakeReason","weakConceptsJson","sourceRefsJson","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT("attemptId","questionId") DO UPDATE SET
        "questionType"=excluded."questionType",
        "difficulty"=excluded."difficulty",
        "question"=excluded."question",
        "optionsJson"=excluded."optionsJson",
        "userAnswerJson"=excluded."userAnswerJson",
        "correctAnswerJson"=excluded."correctAnswerJson",
        "isCorrect"=excluded."isCorrect",
        "score"=excluded."score",
        "analysis"=excluded."analysis",
        "mistakeReason"=excluded."mistakeReason",
        "weakConceptsJson"=excluded."weakConceptsJson",
        "sourceRefsJson"=excluded."sourceRefsJson",
        "updatedAt"=CURRENT_TIMESTAMP`,
      attempt.id,
      item.questionId,
      item.questionType,
      item.difficulty,
      item.question,
      json(item.options),
      json(item.userAnswer, "null"),
      json(item.correctAnswer, "null"),
      item.isCorrect === null ? null : item.isCorrect ? 1 : 0,
      item.score,
      item.analysis,
      item.mistakeReason,
      json(item.weakConcepts),
      json(item.sourceRefs)
    );
  }

  const rows = await quizDb.$queryRawUnsafe(
    `SELECT * FROM "workspace_quiz_question_results" WHERE "attemptId" = ? ORDER BY "id" ASC`,
    attempt.id
  );
  return {
    attempt,
    questionResults: rows.map(publicQuestionResult),
    score,
    accuracy,
  };
}

async function saveWrongQuestions({ workspace, user = null, quiz }) {
  await ensureQuizLearningTables();
  if (!quiz.attemptId) throw new Error("quiz_attempt_missing");
  const userKey = cacheUserKey(user);
  const rows = await quizDb.$queryRawUnsafe(
    `SELECT * FROM "workspace_quiz_question_results" WHERE "attemptId" = ? AND "isCorrect" = 0`,
    Number(quiz.attemptId)
  );
  for (const row of rows) {
    await quizDb.$executeRawUnsafe(
      `INSERT INTO "workspace_quiz_wrong_questions"
        ("workspaceId","userId","cacheUserKey","attemptId","questionResultId","questionId","questionType","topic","question","optionsJson","userAnswerJson","correctAnswerJson","analysis","mistakeReason","weakConceptsJson","sourceRefsJson","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT("workspaceId","cacheUserKey","questionResultId") DO UPDATE SET
        "analysis"=excluded."analysis",
        "mistakeReason"=excluded."mistakeReason",
        "weakConceptsJson"=excluded."weakConceptsJson",
        "sourceRefsJson"=excluded."sourceRefsJson",
        "updatedAt"=CURRENT_TIMESTAMP`,
      workspace.id,
      user?.id || null,
      userKey,
      row.attemptId,
      row.id,
      row.questionId,
      row.questionType,
      quiz.topic || quiz.plan?.topic || null,
      row.question,
      row.optionsJson,
      row.userAnswerJson,
      row.correctAnswerJson,
      row.analysis,
      row.mistakeReason,
      row.weakConceptsJson,
      row.sourceRefsJson
    );
  }
  return { count: rows.length };
}

async function favoriteQuestion({ workspace, user = null, quiz, questionId }) {
  await ensureQuizLearningTables();
  const question = (quiz.questions || []).find(
    (item) => item.id === questionId
  );
  if (!question) throw new Error("quiz_question_not_found");
  const userKey = cacheUserKey(user);
  const result = (quiz.questionResults || []).find(
    (item) => item.questionId === questionId
  );
  await quizDb.$executeRawUnsafe(
    `INSERT INTO "workspace_quiz_favorite_questions"
      ("workspaceId","userId","cacheUserKey","quizId","quizChatId","attemptId","questionResultId","questionId","questionType","topic","difficulty","question","optionsJson","correctAnswerJson","userAnswerJson","analysis","sourceRefsJson","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT("workspaceId","cacheUserKey","quizId","questionId") DO UPDATE SET
      "attemptId"=excluded."attemptId",
      "questionResultId"=excluded."questionResultId",
      "userAnswerJson"=excluded."userAnswerJson",
      "analysis"=excluded."analysis",
      "sourceRefsJson"=excluded."sourceRefsJson",
      "updatedAt"=CURRENT_TIMESTAMP`,
    workspace.id,
    user?.id || null,
    userKey,
    String(quiz.id),
    Number(quiz.chatId || quiz.id),
    quiz.attemptId || null,
    result?.questionResultId || result?.id || null,
    questionId,
    question.type,
    quiz.topic || quiz.plan?.topic || null,
    question.difficulty || null,
    question.question,
    json(question.options || []),
    json(question.correctAnswer, "null"),
    json(result?.userAnswer ?? quiz.answers?.[questionId], "null"),
    result?.analysis || "",
    json(result?.sourceRefs || question.sourceRefs || [])
  );
  return { success: true };
}

async function unfavoriteQuestion({
  workspace,
  user = null,
  quiz,
  questionId,
}) {
  await ensureQuizLearningTables();
  await quizDb.$executeRawUnsafe(
    `DELETE FROM "workspace_quiz_favorite_questions"
     WHERE "workspaceId" = ? AND "cacheUserKey" = ? AND "quizId" = ? AND "questionId" = ?`,
    workspace.id,
    cacheUserKey(user),
    String(quiz.id),
    String(questionId)
  );
  return { success: true };
}

module.exports = {
  cacheUserKey,
  ensureQuizLearningTables,
  upsertAttemptAndQuestionResults,
  saveWrongQuestions,
  favoriteQuestion,
  unfavoriteQuestion,
};
