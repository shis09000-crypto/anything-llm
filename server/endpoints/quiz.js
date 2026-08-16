const { reqBody, userFromSession } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  ROLES,
  flexUserRoleValid,
} = require("../utils/middleware/multiUserProtected");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { writeResponseChunk } = require("../utils/helpers/chat/responses");
const {
  abandonQuiz,
  deleteFavoriteQuestion,
  dismissQuizWrongQuestions,
  generateQuiz,
  quizStatus,
  quizHistory,
  saveFavoriteQuestion,
  saveQuizProgress,
  saveQuizWrongQuestions,
  submitQuiz,
  submitQuizStream,
} = require("../utils/quiz");
const {
  setSseTransportHeaders,
} = require("../utils/security/transportSecurity");

function quizEndpoints(app) {
  if (!app) return;

  app.get(
    "/workspace/:slug/quiz-history",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        response.status(200).json(
          await quizHistory({
            workspace: response.locals.workspace,
            user,
            threadSlug: request.query.threadSlug || null,
          })
        );
      } catch (error) {
        console.error("[Quiz] history endpoint failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/generate",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const {
          message = "",
          threadSlug = null,
          nodeContext = null,
          clientTurnId = null,
        } = reqBody(request);
        if (typeof message !== "string" || message.trim().length === 0) {
          response
            .status(400)
            .json({ success: false, error: "message_required" });
          return;
        }
        const result = await generateQuiz({
          workspace,
          user,
          message: message.trim(),
          threadSlug,
          nodeContext,
          clientTurnId,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] generate endpoint failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/quiz/:quizId/status",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const result = await quizStatus({
          workspace,
          user,
          quizId: request.params.quizId,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] status endpoint failed", error);
        response.status(404).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/:quizId/submit",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const { answers = {} } = reqBody(request);
        const result = await submitQuiz({
          workspace,
          user,
          quizId: request.params.quizId,
          answers,
        });
        response.status(result.success ? 200 : 409).json(result);
      } catch (error) {
        console.error("[Quiz] submit endpoint failed", error);
        response
          .status(error.httpStatus || 500)
          .json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/:quizId/submit-stream",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      setSseTransportHeaders(response, {
        "Access-Control-Allow-Origin": "*",
      });
      response.flushHeaders();
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const { answers = {} } = reqBody(request);
        await submitQuizStream({
          response,
          workspace,
          user,
          quizId: request.params.quizId,
          answers,
        });
        response.end();
      } catch (error) {
        console.error("[Quiz] submit stream endpoint failed", error);
        writeResponseChunk(response, {
          id: request.params.quizId,
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: error.message,
        });
        response.end();
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/:quizId/progress",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const { answers = {}, currentIndex = 0 } = reqBody(request);
        const result = await saveQuizProgress({
          workspace,
          user,
          quizId: request.params.quizId,
          answers,
          currentIndex,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] progress endpoint failed", error);
        response.status(409).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/:quizId/abandon",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const result = await abandonQuiz({
          workspace,
          user,
          quizId: request.params.quizId,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] abandon endpoint failed", error);
        response.status(409).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/:quizId/wrong-questions",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const result = await saveQuizWrongQuestions({
          workspace,
          user,
          quizId: request.params.quizId,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] wrong questions endpoint failed", error);
        response.status(409).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/:quizId/wrong-questions/dismiss",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const result = await dismissQuizWrongQuestions({
          workspace,
          user,
          quizId: request.params.quizId,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] dismiss wrong questions endpoint failed", error);
        response.status(409).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/workspace/:slug/quiz/:quizId/favorite-question",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const { questionId } = reqBody(request);
        const result = await saveFavoriteQuestion({
          workspace,
          user,
          quizId: request.params.quizId,
          questionId,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] favorite endpoint failed", error);
        response.status(409).json({ success: false, error: error.message });
      }
    }
  );

  app.delete(
    "/workspace/:slug/quiz/:quizId/favorite-question/:questionId",
    [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const result = await deleteFavoriteQuestion({
          workspace,
          user,
          quizId: request.params.quizId,
          questionId: request.params.questionId,
        });
        response.status(200).json(result);
      } catch (error) {
        console.error("[Quiz] unfavorite endpoint failed", error);
        response.status(409).json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { quizEndpoints };
