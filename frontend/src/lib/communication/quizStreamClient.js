import { postJsonSse } from "./streamClient";

export async function streamQuizSubmit({
  workspaceSlug,
  quizId,
  answers = {},
  onEvent = null,
  onError = null,
  onClose = null,
} = {}) {
  if (!workspaceSlug || !quizId) return;

  await postJsonSse({
    path: `/workspace/${workspaceSlug}/quiz/${quizId}/submit-stream`,
    body: { answers },
    openWhenHidden: true,
    communicationScene: "workspace-chat",
    task: {
      label: "workspace:quiz-submit-stream",
      kind: "realtime-stream",
      priority: "P0",
      policy: "realtime",
      resource: "realtime",
      protected: true,
      abortable: false,
      scope: {
        route: "workspace-chat",
        surface: "quiz",
        workspaceSlug,
      },
    },
    onMessage(event, rawMessage) {
      onEvent?.(event, rawMessage);
    },
    onClose,
    onError(error) {
      onError?.(error);
    },
  });
}
