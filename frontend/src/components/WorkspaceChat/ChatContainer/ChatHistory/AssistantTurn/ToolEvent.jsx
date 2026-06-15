import { Warning } from "@phosphor-icons/react";
import ToolApprovalRequest from "../ToolApprovalRequest";
import ClarifyingQuestionCard from "../ClarifyingQuestion";

export default function ToolEvent({
  event,
  approvalResult = null,
  approvalState = null,
  chatKey,
  onToolApprovalResponse,
  onClarificationResponse,
}) {
  if (event.type === "approval_request") {
    return (
      <ToolApprovalRequest
        requestId={event.requestId}
        skillName={event.skillName}
        payload={event.payload}
        description={event.description}
        timeoutMs={event.timeoutMs}
        allowAlwaysAllow={event.allowAlwaysAllow !== false}
        approvalState={
          approvalState?.requestId === event.requestId
            ? approvalState
            : {
                ...event,
                approved:
                  approvalResult?.approved === true ||
                  approvalResult?.approved === false
                    ? approvalResult.approved
                    : null,
                responded: !!approvalResult,
              }
        }
        onResponse={(approved) =>
          onToolApprovalResponse?.(chatKey, event.requestId, approved)
        }
      />
    );
  }

  if (event.type === "approval_result") return null;
  if (event.type === "clarification_request") {
    return (
      <ClarifyingQuestionCard
        requestId={event.requestId}
        questions={event.questions || []}
        allowSkip={event.allowSkip !== false}
        timeoutMs={event.timeoutMs}
        onRespond={(_, payload) =>
          onClarificationResponse?.(chatKey, event.requestId, payload)
        }
      />
    );
  }
  if (event.type === "clarification_result") return null;
  if (event.type === "error") return <ErrorEvent event={event} />;
  return null;
}

function ErrorEvent({ event }) {
  return (
    <div className="flex justify-start w-full my-1">
      <div className="p-2 rounded-lg bg-red-50 text-red-500">
        <span className="inline-flex items-center gap-1">
          <Warning className="h-4 w-4" /> {event.content || "Agent error"}
        </span>
      </div>
    </div>
  );
}
