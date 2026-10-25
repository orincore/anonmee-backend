import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { RedisClient } from "../../lib/redis";
import type { PresenceService } from "./presence.service";
import { ageFromDob } from "../../contracts";

export interface ActivityService {
  recordScreenTime(userId: string, seconds: number): Promise<void>;
  recordMessageSent(userId: string): Promise<void>;
  getActivityAnalytics(
    days: number,
    search?: string,
    page?: number,
    limit?: number
  ): Promise<ActivityAnalyticsResult>;
}

export interface ActivityAnalyticsResult {
  summary: {
    totalScreenTimeSeconds: number;
    averageScreenTimePerUserSeconds: number;
    todayScreenTimeSeconds: number;
    onlineUsersNow: number;
    activeUsersPeriod: number;
    activeUsersToday: number;
    totalMessagesSent: number;
  };
  daily: {
    day: string;
    screenTimeSeconds: number;
    activeUsers: number;
    avgMinutesPerUser: number;
    messagesSent: number;
  }[];
  hourlyActivity: {
    hour: number;
    label: string;
    count: number;
  }[];
  users: {
    id: string;
    username: string;
    email: string;
    gender: string;
    age: number;
    totalScreenTimeSeconds: number;
    todayScreenTimeSeconds: number;
    messagesSent: number;
    lastSeenAt: number | null;
    createdAt: number;
    isOnline: boolean;
  }[];
  totalUsers: number;
  page: number;
  totalPages: number;
}

export function activityService(db: Db, redis: RedisClient, presence: PresenceService): ActivityService {
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const currentHour = () => new Date().getHours();

  return {
    async recordScreenTime(userId: string, seconds: number) {
      if (seconds <= 0 || seconds > 300) return;
      const day = todayStr();
      const hour = currentHour();

      // Redis fast counters
      try {
        const m = redis.multi();
        m.incrby(`user:${userId}:screentime:total`, seconds);
        m.incrby(`user:${userId}:screentime:daily:${day}`, seconds);
        m.expire(`user:${userId}:screentime:daily:${day}`, 86400 * 7);
        m.incrby(`platform:screentime:daily:${day}`, seconds);
        m.incrby(`platform:activity:hourly:${hour}`, 1);
        await m.exec();
      } catch {
        // non-fatal
      }

      // Postgres persistence
      try {
        await db.execute(sql`
          INSERT INTO user_activity_daily (user_id, day, screen_time_seconds, updated_at)
          VALUES (${userId}, ${day}::date, ${seconds}, now())
          ON CONFLICT (user_id, day)
          DO UPDATE SET
            screen_time_seconds = user_activity_daily.screen_time_seconds + ${seconds},
            updated_at = now()
        `);
        await db.execute(sql`
          UPDATE users
          SET screen_time_seconds = screen_time_seconds + ${seconds},
              last_seen_at = now()
          WHERE id = ${userId}::uuid
        `);
      } catch (e) {
        console.error("failed to record screen time in db", e);
      }
    },

    async recordMessageSent(userId: string) {
      const day = todayStr();
      const hour = currentHour();
      void redis.incrby(`platform:activity:hourly:${hour}`, 1).catch(() => {});

      try {
        await db.execute(sql`
          INSERT INTO user_activity_daily (user_id, day, messages_sent, updated_at)
          VALUES (${userId}, ${day}::date, 1, now())
          ON CONFLICT (user_id, day)
          DO UPDATE SET
            messages_sent = user_activity_daily.messages_sent + 1,
            updated_at = now()
        `);
      } catch (e) {
        console.error("failed to record message activity in db", e);
      }
    },

    async getActivityAnalytics(
      days: number = 7,
      search?: string,
      page: number = 1,
      limit: number = 20
    ): Promise<ActivityAnalyticsResult> {
      const safeLimit = Math.min(Math.max(1, limit), 100);
      const safePage = Math.max(1, page);
      const offset = (safePage - 1) * safeLimit;
      const daysInterval = Math.min(Math.max(1, days), 90);

      // 1. Summary Metrics
      const [summaryRes, todayRes, periodRes] = await Promise.all([
        db.execute<{ total_sec: number; avg_sec: number; total_users: number }>(sql`
          SELECT
            coalesce(sum(screen_time_seconds), 0)::int as total_sec,
            coalesce(avg(screen_time_seconds) filter (where screen_time_seconds > 0), 0)::int as avg_sec,
            count(*)::int as total_users
          FROM users
        `),
        db.execute<{ today_sec: number; today_users: number; today_messages: number }>(sql`
          SELECT
            coalesce(sum(screen_time_seconds), 0)::int as today_sec,
            count(distinct user_id)::int as today_users,
            coalesce(sum(messages_sent), 0)::int as today_messages
          FROM user_activity_daily
          WHERE day = CURRENT_DATE
        `),
        db.execute<{ period_users: number; period_messages: number }>(sql`
          SELECT
            count(distinct user_id)::int as period_users,
            coalesce(sum(messages_sent), 0)::int as period_messages
          FROM user_activity_daily
          WHERE day >= CURRENT_DATE - (${daysInterval - 1} * interval '1 day')
        `),
      ]);

      const onlineCount = await presence.count();
      const summaryRow = summaryRes[0] || { total_sec: 0, avg_sec: 0, total_users: 0 };
      const todayRow = todayRes[0] || { today_sec: 0, today_users: 0, today_messages: 0 };
      const periodRow = periodRes[0] || { period_users: 0, period_messages: 0 };

      // 2. Daily breakdown trend
      const dailyRows = await db.execute<{
        day: string;
        screen_time_seconds: number;
        active_users: number;
        messages_sent: number;
        avg_minutes_per_user: number;
      }>(sql`
        SELECT
          to_char(d.day, 'YYYY-MM-DD') as day,
          coalesce(uad.total_sec, 0)::int as screen_time_seconds,
          coalesce(uad.active_users, 0)::int as active_users,
          coalesce(uad.messages, 0)::int as messages_sent,
          case when coalesce(uad.active_users, 0) > 0
            then round((coalesce(uad.total_sec, 0)::numeric / uad.active_users) / 60.0, 1)::float
            else 0::float
          end as avg_minutes_per_user
        FROM generate_series(
          (CURRENT_DATE - (${daysInterval - 1} * interval '1 day'))::timestamp,
          CURRENT_DATE::timestamp,
          interval '1 day'
        ) d(day)
        LEFT JOIN (
          SELECT
            day,
            sum(screen_time_seconds) as total_sec,
            count(distinct user_id) as active_users,
            sum(messages_sent) as messages
          FROM user_activity_daily
          WHERE day >= CURRENT_DATE - (${daysInterval - 1} * interval '1 day')
          GROUP BY day
        ) uad ON uad.day = d.day::date
        ORDER BY d.day ASC;
      `);

      // 3. Hourly Activity (24 hours)
      const hourlyRows = await db.execute<{ hour: number; count: number }>(sql`
        SELECT
          h.hour::int,
          coalesce(cnt.count, 0)::int as count
        FROM generate_series(0, 23) h(hour)
        LEFT JOIN (
          SELECT extract(hour from created_at)::int as hour, count(*)::int as count
          FROM room_messages
          WHERE created_at >= now() - interval '14 days'
          GROUP BY 1
        ) cnt ON cnt.hour = h.hour
        ORDER BY h.hour ASC;
      `);

      const formatHour = (h: number) => {
        const ampm = h >= 12 ? "PM" : "AM";
        const hour12 = h % 12 === 0 ? 12 : h % 12;
        return `${hour12} ${ampm}`;
      };

      const hourlyActivity = hourlyRows.map((r) => ({
        hour: r.hour,
        label: formatHour(r.hour),
        count: r.count,
      }));

      // 4. Per-User table with pagination & search
      const searchTerm = search?.trim() ? `%${search.trim().replace(/[%_\\]/g, "\\$&")}%` : null;

      const [userCountRes, userRows] = await Promise.all([
        db.execute<{ count: number }>(sql`
          SELECT count(*)::int as count
          FROM users u
          WHERE ${searchTerm ? sql`(u.username ILIKE ${searchTerm} OR u.email ILIKE ${searchTerm})` : sql`TRUE`}
        `),
        db.execute<{
          id: string;
          username: string;
          email: string;
          gender: string;
          date_of_birth: Date;
          created_at: Date;
          last_seen_at: Date | null;
          screen_time_seconds: number;
          today_screen_time_seconds: number;
          today_messages_sent: number;
        }>(sql`
          SELECT
            u.id::text,
            u.username,
            u.email,
            u.gender::text,
            u.date_of_birth,
            u.created_at,
            u.last_seen_at,
            u.screen_time_seconds,
            coalesce(today_stat.screen_time_seconds, 0)::int as today_screen_time_seconds,
            coalesce(today_stat.messages_sent, 0)::int as today_messages_sent
          FROM users u
          LEFT JOIN user_activity_daily today_stat
            ON today_stat.user_id = u.id AND today_stat.day = CURRENT_DATE
          WHERE ${searchTerm ? sql`(u.username ILIKE ${searchTerm} OR u.email ILIKE ${searchTerm})` : sql`TRUE`}
          ORDER BY u.screen_time_seconds DESC, u.created_at DESC
          LIMIT ${safeLimit} OFFSET ${offset}
        `),
      ]);

      const totalFilteredUsers = userCountRes[0]?.count ?? 0;
      const totalPages = Math.ceil(totalFilteredUsers / safeLimit) || 1;

      // Online status check for the current page users
      const usersWithOnline = await Promise.all(
        userRows.map(async (u) => ({
          id: u.id,
          username: u.username,
          email: u.email,
          gender: u.gender,
          age: ageFromDob(new Date(u.date_of_birth)),
          totalScreenTimeSeconds: Number(u.screen_time_seconds || 0),
          todayScreenTimeSeconds: Number(u.today_screen_time_seconds || 0),
          messagesSent: Number(u.today_messages_sent || 0),
          lastSeenAt: u.last_seen_at ? new Date(u.last_seen_at).getTime() : null,
          createdAt: new Date(u.created_at).getTime(),
          isOnline: await presence.isOnline(u.id),
        }))
      );

      return {
        summary: {
          totalScreenTimeSeconds: Number(summaryRow.total_sec || 0),
          averageScreenTimePerUserSeconds: Math.round(Number(summaryRow.avg_sec || 0)),
          todayScreenTimeSeconds: Number(todayRow.today_sec || 0),
          onlineUsersNow: onlineCount,
          activeUsersPeriod: Number(periodRow.period_users || 0),
          activeUsersToday: Number(todayRow.today_users || 0),
          totalMessagesSent: Number(periodRow.period_messages || 0),
        },
        daily: dailyRows.map((r) => ({
          day: r.day,
          screenTimeSeconds: Number(r.screen_time_seconds || 0),
          activeUsers: Number(r.active_users || 0),
          avgMinutesPerUser: Number(r.avg_minutes_per_user || 0),
          messagesSent: Number(r.messages_sent || 0),
        })),
        hourlyActivity,
        users: usersWithOnline,
        totalUsers: totalFilteredUsers,
        page: safePage,
        totalPages,
      };
    },
  };
}
