import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { streamSyncCenterEvents } from "@/lib/communication";
import { markLoginBoot } from "@/utils/loginBootPerf";
import { recordCommunicationEvent } from "@/lib/communication/communicationMetrics";

const EVENT_CACHE_LIMIT = 500;
const SyncCenterContext = createContext(null);

function handlerKey(namespace = "*", type = "*") {
  return `${namespace}.${type}`;
}

function matchingHandlers(handlers = {}, event = {}) {
  const namespace = event.namespace || "*";
  const type = event.type || "*";
  return [
    handlers[handlerKey(namespace, type)],
    handlers[handlerKey(namespace, "*")],
    handlers[handlerKey("*", type)],
    handlers["*"],
  ].filter((handler) => typeof handler === "function");
}

function rememberEvent(seenEvents, eventId) {
  if (!eventId) return false;
  if (seenEvents.has(eventId)) return false;
  seenEvents.add(eventId);
  if (seenEvents.size > EVENT_CACHE_LIMIT) {
    const oldest = seenEvents.values().next().value;
    seenEvents.delete(oldest);
  }
  return true;
}

export function SyncCenterProvider({ children, enabled = true }) {
  const subscribersRef = useRef(new Map());
  const seenEventsRef = useRef(new Set());
  const nextSubscriberIdRef = useRef(0);
  const connectedMarkedRef = useRef(false);

  const subscribe = useCallback((handlers = {}) => {
    const subscriberId = nextSubscriberIdRef.current + 1;
    nextSubscriberIdRef.current = subscriberId;
    subscribersRef.current.set(subscriberId, handlers);
    recordCommunicationEvent({
      type: "sync-center-subscriber-add",
      method: "EVENT",
      path: "sync-center:subscriber",
      communicationScene: "sync",
      durationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      ok: true,
      subscriberCount: subscribersRef.current.size,
    });
    return () => {
      subscribersRef.current.delete(subscriberId);
      recordCommunicationEvent({
        type: "sync-center-subscriber-remove",
        method: "EVENT",
        path: "sync-center:subscriber",
        communicationScene: "sync",
        durationMs: 0,
        requestBytes: 0,
        responseBytes: 0,
        ok: true,
        subscriberCount: subscribersRef.current.size,
      });
    };
  }, []);

  const emit = useCallback((event) => {
    if (!event?.namespace || !event?.type) return;
    if (!rememberEvent(seenEventsRef.current, event.eventId)) return;

    subscribersRef.current.forEach((handlers) => {
      for (const handler of matchingHandlers(handlers, event)) {
        handler(event);
      }
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    recordCommunicationEvent({
      type: "sync-center-provider-start",
      method: "EVENT",
      path: "/sync/events",
      communicationScene: "sync",
      durationMs: 0,
      requestBytes: 0,
      responseBytes: 0,
      ok: true,
    });

    streamSyncCenterEvents({
      signal: controller.signal,
      onEvent: (event) => {
        if (!connectedMarkedRef.current) {
          connectedMarkedRef.current = true;
          markLoginBoot("sync_connected", {
            firstEvent: event?.type || null,
          });
        }
        emit(event);
      },
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn("[SyncCenter] stream stopped", error.message);
    });

    return () => {
      controller.abort();
      recordCommunicationEvent({
        type: "sync-center-provider-stop",
        method: "EVENT",
        path: "/sync/events",
        communicationScene: "sync",
        durationMs: 0,
        requestBytes: 0,
        responseBytes: 0,
        ok: true,
      });
    };
  }, [emit, enabled]);

  const value = useMemo(() => ({ subscribe }), [subscribe]);

  return (
    <SyncCenterContext.Provider value={value}>
      {children}
    </SyncCenterContext.Provider>
  );
}

export function useSyncCenterEvents({ handlers = {}, enabled = true } = {}) {
  const context = useContext(SyncCenterContext);
  const seenEventsRef = useRef(new Set());
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  const fallbackEmit = useCallback((event) => {
    if (!event?.namespace || !event?.type) return;
    if (!rememberEvent(seenEventsRef.current, event.eventId)) return;
    for (const handler of matchingHandlers(handlersRef.current, event)) {
      handler(event);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (context?.subscribe) return context.subscribe(handlers);

    const controller = new AbortController();
    streamSyncCenterEvents({
      signal: controller.signal,
      onEvent: fallbackEmit,
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn("[SyncCenter] stream stopped", error.message);
    });

    return () => controller.abort();
  }, [context, enabled, fallbackEmit, handlers]);
}
