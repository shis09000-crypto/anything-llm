import React, { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";

import AgentAnimation from "@/media/animations/agent-animation.webm";
import AgentStatic from "@/media/animations/agent-static.png";
import { useTranslation } from "react-i18next";
import { formatTimelineContent } from "@/utils/chat/toolTimelineI18n";

export default function StatusResponse({ messages = [], isThinking = false }) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(false);
  const currentThought = messages[messages.length - 1];
  const previousThoughts = messages.slice(0, -1);

  function handleExpandClick() {
    if (!previousThoughts.length > 0) return;
    setIsExpanded(!isExpanded);
  }

  return (
    <div className="flex justify-center w-full pr-4">
      <div className="w-full flex flex-col">
        <div className="w-full">
          <div
            onClick={handleExpandClick}
            style={{
              transition: "all 0.1s",
              borderRadius: "16px",
            }}
            className="relative bg-zinc-800 light:bg-slate-100 p-4"
          >
            <div className="absolute top-4 left-4 w-[18px] h-[18px]">
              {isThinking ? (
                <video
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="w-[18px] h-[18px] scale-[165%] motion-hover light:invert light:opacity-50"
                  data-tooltip-id="agent-thinking"
                  data-tooltip-content={t(
                    "chat_window.toolTimeline.agentThinking"
                  )}
                  aria-label={t("chat_window.toolTimeline.agentThinking")}
                >
                  <source src={AgentAnimation} type="video/webm" />
                </video>
              ) : (
                <img
                  src={AgentStatic}
                  alt={t("chat_window.toolTimeline.agentComplete")}
                  className="w-[18px] h-[18px] motion-hover light:invert light:opacity-50"
                  data-tooltip-id="agent-thinking"
                  data-tooltip-content={t(
                    "chat_window.toolTimeline.agentComplete"
                  )}
                  aria-label={t("chat_window.toolTimeline.agentComplete")}
                />
              )}
            </div>
            {previousThoughts?.length > 0 && (
              <button
                onClick={handleExpandClick}
                className="absolute top-4 right-4 border-none text-zinc-200 light:text-slate-800 motion-hover"
                data-tooltip-id="expand-cot"
                data-tooltip-content={
                  isExpanded
                    ? t("chat_window.toolTimeline.hideThoughtChain")
                    : t("chat_window.toolTimeline.showThoughtChain")
                }
                aria-label={
                  isExpanded
                    ? t("chat_window.toolTimeline.hideThoughtChain")
                    : t("chat_window.toolTimeline.showThoughtChain")
                }
              >
                <CaretDown
                  className={`w-4 h-4 transform motion-hover ${isExpanded ? "rotate-180" : ""}`}
                />
              </button>
            )}
            <div
              className={`ml-[28px] mr-[26px] transition-[max-height] origin-top ${isExpanded ? "" : "overflow-hidden max-h-[18px]"}`}
            >
              <div className="text-zinc-200 light:text-slate-800 font-mono text-sm leading-[18px]">
                {!isExpanded ? (
                  <span className="block w-full truncate">
                    {formatTimelineContent(currentThought.content, t)}
                  </span>
                ) : (
                  <>
                    {previousThoughts.map((thought, index) => (
                      <div
                        key={`cot-${thought.uuid || index}`}
                        className="mb-2"
                      >
                        {formatTimelineContent(thought.content, t)}
                      </div>
                    ))}
                    <div>
                      {formatTimelineContent(currentThought.content, t)}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
