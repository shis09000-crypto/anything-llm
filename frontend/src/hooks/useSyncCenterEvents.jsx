import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { streamSyncCenterEvents } from "@/lib/communication";

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

  const subscribe = useCallback((handlers = {}) => {
    const subscriberId = nextSubscriberIdRef.current + 1;
    nextSubscriberIdRef.current = subscriberId;
    subscribersRef.current.set(subscriberId, handlers);
    return () => subscribersRef.current.delete(subscriberId);
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

    streamSyncCenterEvents({
      signal: controller.signal,
      onEvent: emit,
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn("[SyncCenter] stream stopped", error.message);
    });

    return () => controller.abort();
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
