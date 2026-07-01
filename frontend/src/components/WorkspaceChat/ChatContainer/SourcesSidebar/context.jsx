import { createContext, useContext, useEffect, useState } from "react";
import {
  estimatePayloadBytes,
  setSourcesMemoryStatsProvider,
} from "@/utils/chat/memoryDiagnostics";

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
    setSourcesMemoryStatsProvider(() => ({
      sidebarOpen,
      sourceCount: sources.length,
      retainedBytes: estimatePayloadBytes(sources),
      selectedSourceBytes: estimatePayloadBytes(selectedSource),
    }));
    return () => setSourcesMemoryStatsProvider(null);
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
