import { Router } from "express";
import type { EventRepository, StoredEvent } from "../storage/event-repository.js";
export function jobEventsRouter(events: EventRepository) {
  const r = Router();
  r.get("/:id/events", async (req, res) => {
    res.status(200).set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.flushHeaders();
    const send = (event: StoredEvent) =>
      res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    const last = Number(req.header("last-event-id") ?? 0);
    for (const event of await events.list(Number.isFinite(last) ? last : 0, req.params.id))
      send(event);
    const unsubscribe = events.subscribe(req.params.id, send);
    const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
    req.on("close", () => {
      clearInterval(timer);
      unsubscribe();
    });
  });
  return r;
}
