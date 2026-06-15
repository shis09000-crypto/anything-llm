import { useEffect, useRef, useState } from "react";

/**
 * Drives a count-down progress bar for time-bounded UI prompts.
 * @param {number|null} timeoutMs
 * @param {{ active?: boolean, onTimeout?: () => void, intervalMs?: number }} [options]
 * @returns {number}
 */
export default function useTimeoutProgress(
  timeoutMs,
  { active = true, onTimeout, intervalMs = 100 } = {}
) {
  const [progressPercent, setProgressPercent] = useState(100);
  const startTimeRef = useRef(null);
  const onTimeoutRef = useRef(onTimeout);

  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);

  useEffect(() => {
    if (!timeoutMs || !active) return;
    if (startTimeRef.current === null) startTimeRef.current = Date.now();

    const intervalId = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, timeoutMs - elapsed);
      setProgressPercent((remaining / timeoutMs) * 100);
      if (remaining <= 0) {
        clearInterval(intervalId);
        onTimeoutRef.current?.();
      }
    }, intervalMs);
    return () => clearInterval(intervalId);
  }, [timeoutMs, active, intervalMs]);

  return progressPercent;
}
