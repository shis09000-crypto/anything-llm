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
    onMessage(event, rawMessage) {
      onEvent?.(event, rawMessage);
    },
    onClose,
    onError(error) {
      onError?.(error);
    },
  });
}
