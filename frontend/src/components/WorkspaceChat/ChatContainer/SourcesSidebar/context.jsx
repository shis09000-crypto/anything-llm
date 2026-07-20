import { createContext, useContext, useEffect, useState } from "react";
import { estimatePayloadBytes } from "@/utils/chat/memorySize";

export const SourcesSidebarContext = createContext();

export function SourcesSidebarProvider({ children }) {
  const [sources, setSources] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState(null);

  function openSidebar(newSources) {
    setSources(newSources);
    setSidebarOpen(true);
  }

  function closeSidebar() {
    setSidebarOpen(false);
    setSelectedSource(null);
    setSources([]);
  }

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let disposed = false;
    let unregister = () => {};
    void import("@/utils/chat/memoryDiagnostics").then(
      ({ setSourcesMemoryStatsProvider }) => {
        if (disposed) return;
        setSourcesMemoryStatsProvider(() => ({
          sidebarOpen,
          sourceCount: sources.length,
          retainedBytes: estimatePayloadBytes(sources),
          selectedSourceBytes: estimatePayloadBytes(selectedSource),
        }));
        unregister = () => setSourcesMemoryStatsProvider(null);
      }
    );
    return () => {
      disposed = true;
      unregister();
    };
  }, [selectedSource, sidebarOpen, sources]);

  return (
    <SourcesSidebarContext.Provider
      value={{
        sources,
        sidebarOpen,
        openSidebar,
        closeSidebar,
        selectedSource,
        setSelectedSource,
      }}
    >
      {children}
    </SourcesSidebarContext.Provider>
  );
}

export function useSourcesSidebar() {
  return useContext(SourcesSidebarContext);
}
