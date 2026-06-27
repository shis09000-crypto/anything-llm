import { memo } from "react";
import FileDownloadCard from "../../FileDownloadCard";
import QuizCard from "../../QuizCard";

function HistoricalOutputs({
  outputs = [],
  workspace = null,
  chatKey = null,
  turnId = null,
  className = "flex flex-col gap-2 mt-4",
}) {
  if (!outputs || outputs.length === 0) return null;

  return (
    <div className={className}>
      {outputs.map((output, index) => {
        if (output.type === "QuizCard") {
          return (
            <QuizCard
              key={`${output.type}-${output.payload?.id || index}`}
              quiz={output.payload}
              workspace={workspace}
              chatKey={chatKey}
              turnId={turnId}
            />
          );
        }
        return (
          <FileDownloadCard
            key={`${output.type}-${index}`}
            props={{ content: output.payload }}
          />
        );
      })}
    </div>
  );
}

export default memo(HistoricalOutputs);
