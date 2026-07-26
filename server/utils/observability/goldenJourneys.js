const GOLDEN_JOURNEYS = Object.freeze({
  login: "login",
  chat: "chat",
  agentTool: "agent_tool",
  knowledgeIngest: "knowledge_ingest",
  crossDeviceSync: "cross_device_sync",
});

const JOURNEY_REQUIREMENTS = Object.freeze({
  [GOLDEN_JOURNEYS.login]: ["requestId", "interactionId"],
  [GOLDEN_JOURNEYS.chat]: ["requestId", "clientTurnId"],
  [GOLDEN_JOURNEYS.agentTool]: ["invocationId", "toolCallId"],
  [GOLDEN_JOURNEYS.knowledgeIngest]: ["requestId"],
  [GOLDEN_JOURNEYS.crossDeviceSync]: ["requestId", "clientId"],
});

function requestPath(request) {
  return String(request?.path || request?.url || "").split("?")[0];
}

function classifyGoldenJourney(request) {
  const method = String(request?.method || "GET").toUpperCase();
  const path = requestPath(request);
  if (
    method === "POST" &&
    [
      "/api/request-token",
      "/api/auth/passkeys/login/verify",
      "/api/auth/zk-login/login/finish",
    ].includes(path)
  )
    return GOLDEN_JOURNEYS.login;
  if (method === "POST" && /\/stream-chat$/.test(path))
    return GOLDEN_JOURNEYS.chat;
  if (
    method === "POST" &&
    /(upload-and-embed|update-embeddings|embed-parsed-file|embed-content)/.test(
      path
    )
  )
    return GOLDEN_JOURNEYS.knowledgeIngest;
  if (
    /\/api\/(sync\/events\/replay|sync\/thread-fingerprints|native-app\/bootstrap)$/.test(
      path
    )
  )
    return GOLDEN_JOURNEYS.crossDeviceSync;
  return null;
}

function requirementsForJourney(journey) {
  return JOURNEY_REQUIREMENTS[journey] || [];
}

function beginGoldenJourney(response, journey, startedAt = Date.now()) {
  if (!response || !journey) return null;
  if (!response.__athenaGoldenJourney) {
    response.__athenaGoldenJourney = {
      journey,
      startedAt,
      milestones: new Set(),
    };
  }
  return response.__athenaGoldenJourney;
}

function markGoldenJourneyMilestone(response, milestone) {
  const state = response?.__athenaGoldenJourney;
  if (!state || !milestone || state.milestones.has(milestone)) return false;
  state.milestones.add(milestone);
  const { metrics } = require("./metrics");
  metrics.goldenJourneyMilestones.observe(
    { journey: state.journey, milestone: String(milestone).slice(0, 64) },
    Math.max(Date.now() - state.startedAt, 0) / 1000
  );
  return true;
}

module.exports = {
  GOLDEN_JOURNEYS,
  JOURNEY_REQUIREMENTS,
  classifyGoldenJourney,
  beginGoldenJourney,
  markGoldenJourneyMilestone,
  requirementsForJourney,
};
