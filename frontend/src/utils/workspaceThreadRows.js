export const COLLAPSED_THREAD_LIMIT = 5;

function isOverviewThreadRow(row = {}) {
  return row.thread?.thread_type === "overview";
}

export function visibleThreadRows({
  sortedThreadRows = [],
  activeThreadSlug = null,
  expanded = false,
  collapsedLimit = COLLAPSED_THREAD_LIMIT,
}) {
  if (expanded) {
    return {
      threadRows: sortedThreadRows,
      hiddenThreadCount: 0,
    };
  }

  const overviewThreadRows = sortedThreadRows.filter(({ thread }) =>
    isOverviewThreadRow({ thread })
  );
  const chatThreadRows = sortedThreadRows.filter(
    ({ thread }) => !isOverviewThreadRow({ thread })
  );
  const visibleChatRows = chatThreadRows.slice(0, collapsedLimit);
  const activeRow = activeThreadSlug
    ? chatThreadRows.find(({ thread }) => thread?.slug === activeThreadSlug)
    : null;
  const activeAlreadyVisible =
    !activeRow ||
    visibleChatRows.some(({ thread }) => thread?.slug === activeThreadSlug);
  const threadRows = [
    ...overviewThreadRows,
    ...visibleChatRows,
    ...(activeAlreadyVisible ? [] : [activeRow]),
  ];

  return {
    threadRows,
    hiddenThreadCount: Math.max(
      chatThreadRows.length - visibleChatRows.length,
      0
    ),
  };
}
