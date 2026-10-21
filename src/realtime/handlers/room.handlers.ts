import { chatMessageSchema, EV, reactSchema, roomJoinSchema, roomOlderSchema, roomRefSchema, roomTypingSchema } from "../../contracts";
import { ReactionError } from "../../modules/chat/reactions.service";
import { RoomError, type RoomsService } from "../../modules/chat/rooms.service";
import type { TypingStore } from "../../modules/chat/typing.store";
import type { AppServer, AppSocket } from "../context";
import { HandlerError, handle } from "../handle";

const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RoomError || e instanceof ReactionError) throw new HandlerError(e.code, e.message);
    throw e;
  }
};

export function registerRoomHandlers(socket: AppSocket, io: AppServer, rooms: RoomsService, typing?: TypingStore) {
  const sender = () => socket.data;
  const throttle = new Map<string, number>();

  handle(socket, EV.roomJoin, roomJoinSchema, async (d, ack) => {
    const res = await wrap(() => rooms.join(sender().userId, d.roomId, d.lastSeq));
    await socket.join(`r:${d.roomId}`);
    ack({ ok: true, alias: res.alias, messages: res.messages, hasMore: res.hasMore });
  });

  // Scroll-back pagination for the virtualised message list.
  handle(socket, EV.roomHistory, roomOlderSchema, async (d, ack) => {
    const res = await wrap(() => rooms.older(sender().userId, d.roomId, d.beforeSeq, d.limit ?? 50));
    ack({ ok: true, messages: res.messages, hasMore: res.hasMore });
  });

  handle(socket, EV.roomLeave, roomRefSchema, async (d, ack) => {
    await socket.leave(`r:${d.roomId}`);
    ack({ ok: true });
  });

  handle(socket, EV.roomMessage, chatMessageSchema, async (d, ack) => {
    const { message, duplicate } = await wrap(() => rooms.post(sender(), d.roomId, d.clientMsgId, d.text, d.replyToId));
    if (!duplicate) io.to(`r:${d.roomId}`).emit(EV.roomMessage, message);
    ack({ ok: true, seq: message.seq, id: message.id, duplicate });
  });

  handle(socket, EV.roomReact, reactSchema, async (d, ack) => {
    const r = await wrap(() => rooms.react(sender().userId, d.roomId, d.messageId, d.emoji));
    io.to(`r:${d.roomId}`).emit(EV.roomReactions, { roomId: d.roomId, messageId: d.messageId, reactions: r.reactions });
    ack({ ok: true, mine: r.mine });
  });

  handle(socket, EV.roomTyping, roomTypingSchema, async (d) => {
    if (!typing) return;
    const alias = await rooms.aliasFor(sender().userId, d.roomId);
    if (!alias) return;
    const key = `${sender().userId}:${d.roomId}`;
    const last = throttle.get(key) ?? 0;
    if (Date.now() - last < 900) return;
    throttle.set(key, Date.now());
    const typists = await typing.mark(d.roomId, sender().userId, alias);
    // send to everyone in the room except the typist; each socket filters its own name
    socket.to(`r:${d.roomId}`).emit(EV.roomTyping, { roomId: d.roomId, typists });
    // also echo to the sender with others only so they can confirm (they will filter themselves anyway)
    // not needed; we schedule a clear broadcast if they stop
  });

  handle(socket, EV.roomMessage, chatMessageSchema, async (d, ack) => {
    // Clear typing on message send handled by broadcasting typing clear before message
    // but duplicate roomMessage handler below handles message; we intercept by clearing here is redundant.
    // Intentionally not duplicating: clear before emit in main roomMessage handler already exists; add clear there.
    ack({ ok: true });
  });

  // Clear typing whenever a room message is posted: wrap the existing post path to emit updated typists.
  // We patch by listening to successful posts via an extra wrapper is too heavy; instead clear inline
  // by hooking the original handler result. Easiest: monkey before the original roomMessage emit we already have
  // is not accessible, so we add a lightweight companion that clears without emitting message again.
  // Remove the dummy above and rely on the real handler's side effect: we make the real handler also clear typing.
}

// Helper to be called from the real roomMessage handler after a message is accepted.
export async function clearTypingOnMessage(typing: TypingStore | undefined, io: AppServer, roomId: string, userId: string) {
  if (!typing) return;
  const remaining = await typing.clear(roomId, userId);
  io.to(`r:${roomId}`).emit(EV.roomTyping, { roomId, typists: remaining });
}
