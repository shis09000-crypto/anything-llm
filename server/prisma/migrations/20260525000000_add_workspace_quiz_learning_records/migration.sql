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

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_attempts_workspaceId_cacheUserKey_quizChatId_key"
  ON "workspace_quiz_attempts"("workspaceId", "cacheUserKey", "quizChatId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_attempts_workspaceId_idx"
  ON "workspace_quiz_attempts"("workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_attempts_userId_idx"
  ON "workspace_quiz_attempts"("userId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_attempts_quizChatId_idx"
  ON "workspace_quiz_attempts"("quizChatId");

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

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_question_results_attemptId_questionId_key"
  ON "workspace_quiz_question_results"("attemptId", "questionId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_question_results_attemptId_idx"
  ON "workspace_quiz_question_results"("attemptId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_question_results_questionId_idx"
  ON "workspace_quiz_question_results"("questionId");

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

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_wrong_questions_workspaceId_cacheUserKey_questionResultId_key"
  ON "workspace_quiz_wrong_questions"("workspaceId", "cacheUserKey", "questionResultId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_wrong_questions_workspaceId_idx"
  ON "workspace_quiz_wrong_questions"("workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_wrong_questions_attemptId_idx"
  ON "workspace_quiz_wrong_questions"("attemptId");

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

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_quiz_favorite_questions_workspaceId_cacheUserKey_quizId_questionId_key"
  ON "workspace_quiz_favorite_questions"("workspaceId", "cacheUserKey", "quizId", "questionId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_favorite_questions_workspaceId_idx"
  ON "workspace_quiz_favorite_questions"("workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_quiz_favorite_questions_questionResultId_idx"
  ON "workspace_quiz_favorite_questions"("questionResultId");
