import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventRepository } from "../../src/server/storage/event-repository.js";
describe("event replay",()=>it("replays monotonically after an event ID",async()=>{const path=`${await mkdtemp(`${tmpdir()}/events-`)}/events.ndjson`,repo=new EventRepository(path);await repo.append({type:"progress",timestamp:new Date().toISOString(),message:"started"});await repo.append({type:"progress",timestamp:new Date().toISOString(),message:"finished"});expect((await repo.list(1)).map(x=>x.id)).toEqual([2]);}));
