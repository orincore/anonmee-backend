import type { Db } from "./db/client";
import { buildApp } from "./app";
import type { RedisClient } from "./lib/redis";
import { EV } from "./contracts";
import type { GroupView } from "./modules/groups/groups.routes";
import { chatStore } from "./modules/chat/chat.store";
import { peerResolver } from "./modules/moderation/moderation.peers";
import { reactionsService } from "./modules/chat/reactions.service";
import { roomsService } from "./modules/chat/rooms.service";
import { presenceService } from "./modules/presence/presence.service";
import { pulseService } from "./modules/presence/pulse.service";
import { runRetention } from "./modules/maintenance/retention";
import { createRealtime } from "./realtime/socket";

/** HTTP API and realtime layer on one server. Used by index.ts and by tests. */
export async function buildServer(db: Db, redis: RedisClient) {
  let announce: (g: GroupView) => void = () => {};
  let moderated: (roomId: string, target: string, kind: "block" | "report", banned: boolean) => void = () => {};
  let banned: (userId: string) => void = () => {};
  const chats = chatStore(redis);
  const app = await buildApp(db, {
    onGroupCreated: (g) => announce(g),
    peers: peerResolver(db, redis, chats, () => roomsService(db, redis, reactionsService(redis)).flush()),
    onModerated: (...a) => moderated(...a),
    presence: presenceService(redis),
    pulse: pulseService(redis),
    onUserBanned: (id) => banned(id),
  });
  const rt = createRealtime(app.server, db, redis, chats);
  announce = (g) => {
    rt.io.emit(EV.groupCreated, g);
    // Group titles are public (topic pages list them), so the ticker may show a new one.
    const e = { kind: "group" as const, title: g.title, topic: g.topic, at: Date.now() };
    void rt.pulse.record(e);
    rt.io.of("/public").emit(EV.pulse, e);
  };
  banned = (id) => void rt.io.in(`u:${id}`).disconnectSockets(true);
  moderated = (roomId, target, _kind, banned) => {
    // A reported or blocked 1:1 partner ends the chat at once; a banned account is cut off everywhere.
    void rt.endChatNow(roomId, "reported");
    if (banned) rt.io.in(`u:${target}`).disconnectSockets(true);
  };
  const maintenance = setInterval(() => void runRetention(db, redis).catch((e) => console.error("retention", e)), 3_600_000);
  maintenance.unref();
  setTimeout(() => void runRetention(db, redis).catch(() => {}), 30_000).unref();
  app.addHook("onClose", async () => {
    clearInterval(maintenance);
    await rt.close();
  });
  return { app, rt };
}
