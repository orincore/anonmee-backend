import type { Server, Socket } from "socket.io";
import type { Gender } from "../contracts";

type EventsMap = { [event: string]: (...args: any[]) => void }; // socket.io's own default shape

export interface SocketUser {
  userId: string;
  gender: Gender;
  age: number;
}
export type AppSocket = Socket<EventsMap, EventsMap, EventsMap, SocketUser>;
export type AppServer = Server;

export type Ack = (res: { ok: true; [k: string]: unknown } | { ok: false; error: string; message: string }) => void;
