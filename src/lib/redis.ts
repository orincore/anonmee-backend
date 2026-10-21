import { Redis } from "ioredis";
import { env } from "../config/env";

export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
export type RedisClient = Redis;
