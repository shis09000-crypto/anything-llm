import { useState, useEffect, useRef } from "react";
import { Trash } from "@phosphor-icons/react";
import {
  useMessageActionsContext,
  DELETE_EVENT,
} from "@/components/WorkspaceChat/ChatContainer/ChatHistory/MessageActionsContext";

export function useWatchDeleteMessage({ chatId = null }) {
  const context = useMessageActionsContext();
  const [completeDelete, setCompleteDelete] = useState(false);
  const deleteCalled = useRef(false);
  const isDeleted = context?.isDeleted(chatId) ?? false;

  useEffect(() => {
    if (isDeleted && !deleteCalled.current) {
      deleteCalled.current = true;
    }
  }, [isDeleted, chatId]);

  function onEndAnimation() {
    if (!isDeleted) return;
    setCompleteDelete(true);
  }

  return { isDeleted, completeDelete, onEndAnimation };
}

export function DeleteMessage({
  chatId,
  publicChatId = null,
  isEditing,
  role,
}) {
  if (!chatId || isEditing || role === "user") return null;

  function emitDeleteEvent() {
    window.dispatchEvent(
      new CustomEvent(DELETE_EVENT, {
        detail: { chatId, publicChatId, role },
      })
    );
  }

  return (
    <button
      onClick={emitDeleteEvent}
      className="border-none flex items-center gap-x-1 w-full"
      role="menuitem"
    >
      <Trash size={21} weight="fill" />
      <p>Delete</p>
    </button>
  );
}
