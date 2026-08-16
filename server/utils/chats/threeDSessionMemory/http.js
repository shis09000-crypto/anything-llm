function sendFailure(response, error) {
  const code = String(
    error?.code || error?.message || "athena_3d_memory_failed"
  );
  response.status(Number(error?.httpStatus || 500)).json({
    success: false,
    error: code,
    details: error?.details || null,
  });
}

function registerThreeDSessionMemoryRoutes(app, runtime) {
  const route = (handler, successKey) => async (request, response) => {
    try {
      const result = await handler(request.body || {});
      response.json({ success: true, [successKey]: result });
    } catch (error) {
      sendFailure(response, error);
    }
  };
  app.post(
    "/internal/v1/3d-center/memory/sessions/create",
    route((body) => runtime.createSession(body), "session")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/archive",
    route((body) => runtime.archiveLongTerm(body), "archive")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/finalize",
    route((body) => runtime.finalizeLongTerm(body), "finalization")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/context",
    route((body) => runtime.longTermContext(body), "character_memory")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/recall/freeze",
    route((body) => runtime.freezeLongTermRecall(body), "recall")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/status",
    route((body) => runtime.longTermStatus(body), "character_memory")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/session/delete",
    route((body) => runtime.deleteLongTermSession(body), "deletion")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/profile/reset",
    route((body) => runtime.resetLongTermProfile(body), "deletion")
  );
  app.post(
    "/internal/v1/3d-center/memory/long-term/reconsolidate",
    route((body) => runtime.reconsolidateLongTerm(body), "reconsolidation")
  );
  app.post(
    "/internal/v1/3d-center/memory/sessions/context/resolve",
    route((body) => runtime.contextResolve(body), "context")
  );
  app.post(
    "/internal/v1/3d-center/memory/sessions/context/prepare",
    route((body) => runtime.contextPrepare(body), "context")
  );
  app.post(
    "/internal/v1/3d-center/memory/sessions/turns/commit",
    route((body) => runtime.commitTurn(body), "commit")
  );
  app.post(
    "/internal/v1/3d-center/memory/sessions/status",
    route((body) => runtime.status(body), "status")
  );
  app.post(
    "/internal/v1/3d-center/memory/sessions/delete",
    route((body) => runtime.deleteSession(body), "deletion")
  );
  app.post(
    "/internal/v1/3d-center/memory/maintenance",
    route((body) => runtime.maintain({ limit: body.limit }), "maintenance")
  );
}

module.exports = { registerThreeDSessionMemoryRoutes, sendFailure };
