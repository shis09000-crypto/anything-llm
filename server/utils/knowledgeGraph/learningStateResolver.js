const prisma = require("../prisma");
const {
  WorkspaceKnowledgeProfile,
} = require("../../models/workspaceKnowledgeProfile");

function toState(row = null) {
  if (!row) {
    return {
      viewedCount: 0,
      quizAttemptCount: 0,
      wrongCount: 0,
      correctCount: 0,
      masteryScore: 0,
      confusionScore: 0,
      supplementCount: 0,
      hasUserSupplement: false,
      recommendedCount: 0,
      dismissedCount: 0,
      userMarkedImportant: false,
    };
  }
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspaceId),
    userId: Number(row.userId || 0),
    nodeKey: row.nodeKey,
    viewedCount: Number(row.viewedCount || 0),
    lastViewedAt: row.lastViewedAt || null,
    quizAttemptCount: Number(row.quizAttemptCount || 0),
    wrongCount: Number(row.wrongCount || 0),
    correctCount: Number(row.correctCount || 0),
    masteryScore: Number(row.masteryScore || 0),
    confusionScore: Number(row.confusionScore || 0),
    supplementCount: Number(row.supplementCount || 0),
    hasUserSupplement:
      row.hasUserSupplement === true || row.hasUserSupplement === 1,
    recommendedCount: Number(row.recommendedCount || 0),
    dismissedCount: Number(row.dismissedCount || 0),
    lastRecommendedAt: row.lastRecommendedAt || null,
    userMarkedImportant:
      row.userMarkedImportant === true || row.userMarkedImportant === 1,
  };
}

async function getLearningState({ workspaceId, userId = 0, nodeKey }) {
  await WorkspaceKnowledgeProfile.ensureTables();
  if (!workspaceId || !nodeKey) return toState(null);
  const row = (
    await prisma.$queryRawUnsafe(
      `SELECT * FROM "NodeLearningState"
      WHERE "workspaceId" = ? AND "userId" = ? AND "nodeKey" = ?
      LIMIT 1`,
      Number(workspaceId),
      Number(userId || 0),
      String(nodeKey)
    )
  )?.[0];
  return toState(row);
}

async function recordNodeView({
  workspaceId,
  userId = 0,
  nodeKey,
  supplementCount = 0,
}) {
  await WorkspaceKnowledgeProfile.ensureTables();
  if (!workspaceId || !nodeKey) return null;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "NodeLearningState" (
      "workspaceId","userId","nodeKey","viewedCount","lastViewedAt",
      "supplementCount","hasUserSupplement","updatedAt"
    ) VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT("workspaceId","userId","nodeKey") DO UPDATE SET
      "viewedCount" = "viewedCount" + 1,
      "lastViewedAt" = CURRENT_TIMESTAMP,
      "supplementCount" = excluded."supplementCount",
      "hasUserSupplement" = excluded."hasUserSupplement",
      "updatedAt" = CURRENT_TIMESTAMP`,
    Number(workspaceId),
    Number(userId || 0),
    String(nodeKey),
    Number(supplementCount || 0),
    Number(supplementCount || 0) > 0
  );
  return await getLearningState({ workspaceId, userId, nodeKey });
}

module.exports = {
  getLearningState,
  recordNodeView,
  toState,
};
