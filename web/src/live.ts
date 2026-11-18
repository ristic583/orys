/** Server-sent events → refresh queries. Every state change on the server writes an event row. */
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function useLiveUpdates(): boolean {
  const qc = useQueryClient();
  // Assume connected until the stream reports an error, so the page does not flash "disconnected" on load.
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void qc.invalidateQueries();
      }, 300);
    };
    const es = new EventSource("/api/events/stream");
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("aipm", refresh);
    es.addEventListener("job", refresh);
    es.addEventListener("jobs", () => void qc.invalidateQueries({ queryKey: ["status"] }));
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, [qc]);
  return connected;
}
