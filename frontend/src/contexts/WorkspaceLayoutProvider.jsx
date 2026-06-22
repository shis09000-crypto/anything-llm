import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
} from "react";
import {
  effectiveSidebarCollapsed,
  applyWorkspaceLayoutStorageEvent,
  readInitialLayoutIntent,
  workspaceLayoutReducer,
} from "@/utils/layout/workspaceLayoutState";

const WorkspaceLayoutContext = createContext(null);

export function WorkspaceLayoutProvider({ children }) {
  const [layoutState, reducerDispatch] = useReducer(
    workspaceLayoutReducer,
    undefined,
    () => readInitialLayoutIntent()
  );

  const dispatchLayoutEvent = useCallback((event = {}) => {
    reducerDispatch(event);
    applyWorkspaceLayoutStorageEvent(event);
  }, []);

  const value = useMemo(
    () => ({
      layoutState,
      layoutMode: layoutState.mode,
      effectiveSidebarCollapsed: effectiveSidebarCollapsed(layoutState),
      dispatchLayoutEvent,
    }),
    [dispatchLayoutEvent, layoutState]
  );

  return (
    <WorkspaceLayoutContext.Provider value={value}>
      {children}
    </WorkspaceLayoutContext.Provider>
  );
}

export function useWorkspaceLayout() {
  return useContext(WorkspaceLayoutContext);
}
