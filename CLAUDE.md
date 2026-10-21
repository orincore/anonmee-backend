# CLAUDE.md - Anonmee

Rules for every session in this repo. Read fully before writing code. These are strict: if a change conflicts with this file, change the plan, not the file (unless the user says otherwise).

## 1. Product

Anonmee is a responsive web app (phone first, desktop equal) for **anonymous live chat between strangers**. The product name is **Anonmee** and the domain is **anonmee.in** (wordmark: "anon" plus a tilted "mee" sticker). Production: site at `https://anonmee.in`, API at a subdomain such as `https://api.anonmee.in` so auth cookies stay same-site.

- **Sign-up in under 60 seconds, as a five-step wizard** (`features/auth`, one short screen per step with a progress bar and Back): (1) email, password, username; (2) gender, date of birth, "I am 18 or older"; (3) what you are here for; (4) who you want to meet and the age range; (5) topics (optional). Each step is validated with the shared contract before moving on; the account is created on the last step and preferences are saved right after. No email verification gate before first chat.
- **Random 1:1 matching** in live chat, based on the user's preferences.
- **Live online counter** (real time, shown on landing, home and matching screens).
- **Genders** (own and wanted): Male, Female, Trans man, Trans woman, Non-binary, Prefers not to say. Both are multi-select where it makes sense (you pick one for yourself; you pick any mix of who you want to meet, with an "Anyone" shortcut).
- **What you are here for is two levels, and always multi-select** (`INTENT_GROUPS` in the contracts). Groups: Friendship, Casual chat, **Dating and relationships** (long-term relationship, marriage minded, casual dating, flirting, friends with benefits, one night stand, sexting, online romance), **Open-minded** (open relationship, polyamory, 2-way, 3-way, 4-way, group relationship, same gender, bi-curious, couples, role play, kink friendly, still exploring), Something else. Groups with many options expand to show them. **Matching is on the exact option**: two people are paired only if they share at least one specific choice (sexting never matches long-term). "Same gender" only counts between people who really are the same gender. Public surfaces (the live ticker) only ever show the group, never a specific option. These options are for adults only, text only, always with report and block, and the picker reminds people to keep it consensual.
- **Message actions:** right-click on a computer, press and hold on a phone, or the Menu key opens reply and react on any message (`useLongPress`, `MessageMenu`). Reactions are a fixed set of six emoji, counts only (never who), toggled per person. Replies quote the original; the quote text is copied by the server so it cannot be faked. Emoji are allowed here because the owner asked for reactions.
- **Global chat:** one public room for every user.
- **Interest groups:** any user can create a group with a title, topic (football, cricket, advice, etc.), description and settings. New groups are listed automatically in the global chat area and on Home. Groups are **ranked on each user's Home by overlap with their selected interests**. Anyone can join and chat live.
- **Anonymity is the product.** Nothing identifying is ever shown to another user (see section 3).

## 2. Hard safety rules (non-negotiable)

- **18+ only. No minors, ever.** Sign-up collects **date of birth** (not a free-typed age) and an explicit "I am 18 or older" confirmation. The server computes age from the date of birth and rejects anyone under 18; the client check is only a convenience. A DB check constraint backs it up. Age shown to others and used for matching is recomputed from the date of birth, so it stays correct over time.
- Age is self-declared, which is the honest limit of a no-ID product. Say so in Terms, never claim "verified adults" in copy. Stronger verification (ID or card check) is a later, separate decision; do not add it unasked.
- Underage handling: if a report or signal suggests a user is under 18, ban the account immediately and keep the report. Mention 18+ on the landing page, sign-up and Terms.
- Every chat and group has **Report, Block and Leave** one tap away.
- Server-side moderation hooks from day one: rate limits, profanity/abuse filter hook, report queue table, user ban flag. Never trust the client.
- **No media storage at all.** No image, video, audio or file uploads, no object storage, no CDN for user content. Text only, which also removes a large abuse surface. Links are shown as plain text, not auto-fetched.
- Dating / open-minded intents never override the 18+ rule.

## 3. Anonymity contract (what we promise users, and must actually do)

- **The only real information another user ever sees is gender and age.** Nothing else, anywhere (UI, API, sockets, logs shown to users).
- Other users **never** see: email, username, name, date of birth, account id, IP, device info, location, join date.
- Every other user is shown as a **random alias** (e.g. "Quiet Otter 47") plus **gender and age**, e.g. "Quiet Otter 47, Female, 24". The alias is generated server side per room or chat and is not derivable from the account. Same account gets a different alias in each room.
- Gender and age are always displayed together with the alias in chats, matches and group member lists. No other profile fields exist. No bios, photos, links or custom avatars (a generated alias-based colour/mask is fine).
- Username is private: used for login display and the user's own profile only.
- Passwords hashed with **argon2id**. Emails stored lowercase, never exposed by any API response to other users.
- Chat messages: encrypted in transit (TLS), encrypted at rest at the storage layer. 1:1 chats are **ephemeral by default**: messages are deleted when the chat ends (retain only what a pending report needs, for a fixed short window). Group and global messages retain a rolling window (default 7 days).
- No third-party trackers or ad SDKs. Analytics are first party only (see section 6.3).
- Copy must be honest. Never write "military grade" or "100% unhackable". Say what we actually do.

## 4. Architecture

Two fully separate projects. **The repo root holds only `CLAUDE.md`, `README.md` and `.gitignore`. Nothing else goes in the root, ever.** No root `package.json`, no workspaces, no shared folder. Each project has its own `package.json`, `node_modules`, `.env.example` and `tsconfig.json`. Use npm (pnpm and bun are not installed).

```
anonme/
  CLAUDE.md  README.md  .gitignore
  backend/                      Node + Fastify + Socket.IO, Drizzle ORM, Redis
    docker-compose.yml          local Postgres + Redis (infra belongs to the backend)
    drizzle.config.ts  drizzle/ (generated migrations)
    .env.example
    src/
      index.ts                  boot only: load config, start app, graceful shutdown
      app.ts                    builds the Fastify instance, registers plugins and modules
      config/                   env.ts (zod-validated), constants
      db/                       client.ts, schema.ts
      contracts/                zod schemas + socket event names (the API contract)
      lib/                      pure helpers: hash, tokens, alias generator, rate limit
      realtime/                 socket server setup, auth handshake, presence
      modules/                  one folder per feature, all with the same shape
                                (admin/ and analytics/ included: staff auth, escalations, users, campaigns, stats)
        auth/                   auth.routes.ts, auth.service.ts, auth.repo.ts, auth.test.ts
        matching/  chat/  groups/  moderation/  presence/
  frontend/                     Next.js (App Router, TS), Tailwind v4, Spectrum UI, Motion
    .env.example
    public/                     static files only (favicon, robots assets). No user media.
    src/
      app/                      routes only: thin pages that compose features. (marketing)/ (auth)/ (app)/ (admin)/
      components/
        ui/                     Spectrum UI primitives, restyled to our tokens (button, input, sheet...)
        shared/                 reusable app-wide pieces (Logo, ThemeToggle, OnlineCounter, EmptyState, Skeletons)
        layout/                 Navbar, BottomTabBar, Sidebar, PageShell, Footer
      features/                 one folder per feature: landing/ auth/ matching/ chat/ groups/ profile/ admin/
        <feature>/components/   components used only by that feature
        <feature>/hooks/  <feature>/api.ts  <feature>/types.ts
      lib/                      api client, socket client, utils, seo helpers, constants
      hooks/                    app-wide hooks (useTheme, useMediaQuery, useReducedMotion)
      providers/                Theme, Auth, Socket providers
      contracts/                copy of backend/src/contracts (see below)
      styles/                   globals.css, tokens.css
```

- **Contracts:** `backend/src/contracts` is the source of truth. `frontend/src/contracts` is a copy kept identical (`npm run sync:contracts` in the frontend copies it). Never edit the frontend copy by hand, never import across the backend and frontend folders.
- **Dependency direction:** `app` pages compose `features`; `features` use `components`, `hooks`, `lib`; `components/ui` depends on nothing in the app. No upward or circular imports. Backend: routes call services, services call repos, repos are the only code that touches Drizzle.
- **Reusable component rules (strict):**
  1. Everything visible is a component. No page is a wall of JSX; pages only compose.
  2. If a UI pattern appears twice it moves to `components/shared` or `components/ui`. Check there (and Spectrum UI) before creating a new one.
  3. One component per file, file named after the component (`online-counter.tsx` exports `OnlineCounter`). Max about 150 lines; split before that.
  4. Components take typed props, hold no data fetching or socket logic. Data comes from feature hooks; components stay presentational and reusable.
  5. Styling via Tailwind classes and design tokens only. No inline style colours, no one-off pixel values that duplicate a token. Variants use `cva`.
  6. Every component works in light and dark, at 360px wide, and with keyboard focus.
  7. Export through a folder `index.ts` only for `components/ui` and `components/shared`. Features import from their own folder.
- **Backend module rules:** each feature lives only in `modules/<name>/`; routes are thin (validate with the contract, call service, return); no business logic in routes or socket handlers; shared logic goes in `lib/`.
- Keep folders clean: no stray files in `src/` roots beyond those listed above, no `utils.ts` dumping grounds (name helpers by purpose), no duplicate components with slightly different names.

- **Database:** PostgreSQL via **Drizzle ORM** (`drizzle-orm`, `drizzle-kit` migrations, schema in `backend/src/db/schema.ts`). **Redis** for presence, online count, matchmaking queues, rate limits, Socket.IO adapter (so the server can scale horizontally).
- **Auth:** email + password, argon2id, short-lived access JWT + rotating refresh token in `httpOnly`, `Secure`, `SameSite=Lax` cookies. CSRF protection on cookie-authenticated mutations.
- **Realtime:** Socket.IO with auth handshake. All events validated with zod from `backend/src/contracts`. Event names live in one file, never string literals elsewhere.
- **Matchmaking:** Redis queue keyed by intent; match on intent overlap + gender and age preference both ways; never match a user with someone they blocked or reported; time out gracefully with a friendly state.
- **Production grade means:** env validation at boot (zod), structured logging (pino), helmet, strict CORS, rate limiting on auth and socket events, graceful shutdown, health endpoint, DB migrations only through drizzle-kit, no secrets in the repo, `.env.example` maintained.
- TypeScript `strict: true` everywhere. No `any` without a comment explaining why.

## 5. Core algorithms (must feel instant and never glitch)

Pure scoring logic lives in `modules/<x>/*.score.ts|*.rules.ts|*.recommend.ts` (no I/O, fully unit tested). Redis/DB code wraps it. Never put ranking logic in routes or socket handlers.

### 5.1 Random matching ("Start matching")
- UI shows **"Waiting, finding a match for you"** the instant the user taps Start (optimistic, before the server replies), with a calm animation. When the server emits `match:found` the screen transitions straight into the chat. Minimum visible waiting state is 600ms so it never flashes. After 60s with no match: friendly timeout with "Keep waiting" and "Change preferences". Cancel is always one tap.
- **Hard filters (all mutual, never relaxed):** gender wanted by each side, at least one shared intent, neither blocked the other, not matched in the last 10 minutes, not the same user, not banned. Age range is a hard filter too, but widens by 3 years after 20s of waiting.
- **Score (0-100):** intent overlap 40, shared interests 25, age fit 15, fairness bonus for time waited 20. Deterministic tie-break: longest waiter, then lower user id.
- **Pairing is atomic and race safe:** waiting tickets sit in Redis (sorted set by enqueue time). A pairing attempt scans the oldest 200 tickets, picks the best partner, and removes both tickets in one Lua script that only succeeds if both are still waiting. Two users can never be given the same partner and nobody gets matched twice. A 1s sweeper pairs tickets that arrived at the same moment.
- One active ticket per user (second tab or device replaces the first). Disconnect removes the ticket. Reconnect within 30s restores an existing chat or the queue position.
- Wrong or missing data never produces a match: if a ticket is invalid it is rejected with a clear error, not silently queued.

### 5.2 Group recommendation (Home feed)
- Score = interest/tag match 0.45, recent activity 0.20 (log scaled messages in the last 10 min), freshness 0.15 (12 hour half life), size fit 0.10 (avoid empty and nearly full rooms), popularity 0.10 (log members).
- Never recommend: groups already joined, groups owned by someone the viewer blocked. **Groups have no member limit, ever** (no `maxMembers`, no "full" state). Size only helps ranking: a one-person room scores low, a lively one high.
- Re-rank greedily so the top results are varied by topic. Cold start (no interests): rank by activity, freshness and size. Cache a user's feed in Redis for 30s, invalidate on interest change.

### 5.3 Discovering groups
- Search and browse by topic tag using a GIN index on `tags`; keyset (cursor) pagination, never OFFSET; stable ordering so lists never duplicate or skip items while new groups arrive. New groups appear live in the feed through a socket event, inserted without scroll jumps.

### 5.4 Creating a group
- Idempotent: the client sends an idempotency key, retries return the same group. Validate with the contract, normalise tags (lowercase, synonym map), rate limit 3 groups per hour per user, create the group and add the owner in one transaction, then announce it to the feed.

### 5.5 Joining a group
- One idempotent insert (primary key on group + user, `ON CONFLICT DO NOTHING`), no row lock and no capacity check, so thousands can join a busy group at once without queueing. Check the group is open and the owner has not blocked the user. Joining twice returns the same alias.

### 5.6 Messaging reliability
- Client sends a `clientMsgId`; server dedupes on it, assigns a per-room sequence number (Redis INCR) and acks. Optimistic UI shows the message as sending, then sent, or failed with tap to retry. On reconnect the client sends its last seen sequence and the server replays the gap, so nothing is lost or duplicated. Typing events are throttled. Messages are validated (length, rate limit per user) before broadcast.

### 5.7 Quality bar
- Every algorithm has unit tests for its edge cases (blocked users, very large groups, simultaneous joins, empty pool) and a concurrency test for pairing. A match or join that errors must fail loudly and recover the UI to a usable state, never leave a spinner.
- Targets: match found under 200ms server time when a valid partner is waiting, group join under 150ms, feed under 100ms from cache.

### 5.8 Report and block (safety, always one tap away)
- **Where:** a "more" button in the header of every 1:1 chat, group and global chat, and a long-press or tap on any message author. It opens a bottom sheet on mobile and a popover on desktop with three clear actions: **Report**, **Block**, **Leave**. Minimum 44px rows, destructive actions in the error colour, no confirmation maze (one confirm step at most).
- **Report sheet:** pick a reason (harassment, spam, inappropriate, seems under 18, scam, other), optional 400 char details, a pre-ticked "Also block this person". Submit shows a calm confirmation and the chat ends immediately for a 1:1 chat.
- **Block is permanent and two-way for matching.** A blocked pair is never matched again, never shares a new 1:1 chat, and the blocker no longer sees groups owned by that person in recommendations. Users can review and undo their own blocks in Me > Blocked (shown as aliases from the time of the block, never identities).
- **Anonymity-safe:** the client sends a room id and an alias, never an account id. The server resolves who that is. The reported person is never told who reported them.
- **Escalation:** an "underage" report bans the account immediately (a human can reverse it). 3 distinct reporters in 24h sends the account to the review queue, 5 suspends it until reviewed. Abuse of reporting (many reports with no merit) is reviewed too.
- **Evidence:** the last messages from the reported person are saved with the report for review only, then purged after the review window. They are never shown to other users.
- Matching and recommendation inputs always include `blockedEitherWay(userId)` so blocks apply everywhere.

### 5.9 Scale, pagination and virtualization (thousands chatting at once)
Rules for every list and every hot path. The database must stay nearly idle while thousands of people chat.

**Database**
- **Nothing is unbounded.** Every list endpoint and socket history call is paginated with a keyset cursor (never OFFSET), a default page of 20 to 50 and a hard maximum of 100. Applies to groups, members, messages, blocks, and every admin table.
- **Index every query you write.** Indexes match the query's ORDER BY exactly. Use ascending composite indexes (read backwards for DESC), partial indexes for "open" rows, GIN for tag arrays. Check new queries with `EXPLAIN` at volume before merging; no sort step and no seq scan on big tables.
- **No `count(*)` on hot paths.** Counters live on the row (`groups.member_count`, atomic `+1`) or in Redis. Busy-ness comes from Redis minute buckets, not from scanning messages.
- **Keyset cursor timestamps** use millisecond columns (`timestamp(3)`) so the cursor round-trips exactly. Always add the id as a tie breaker.
- **Chat writes never hit Postgres one by one.** Sending a group or global message touches Redis only (sequence, dedupe, recent window of 100, pending queue). A flusher writes the queue to Postgres in multi-row inserts every 250 ms. Reads for the latest history come from the Redis window; only scroll-back older than that reads Postgres, by `(room_id, seq)` index. Message rows store alias, gender and age at send time, so history never joins `users`.
- **1:1 chats never touch Postgres** for messages (Redis only, deleted after the chat ends). Only a small `matches` row is written.
- Membership and alias lookups are cached in Redis; the cache is cleared on leave.
- Connection pool is bounded (`DB_POOL_MAX`), `statement_timeout` is 10 s, `idle_in_transaction_session_timeout` 15 s. Retention job purges in 5000 row slices (messages after 7 days, closed-report evidence after 30 days, old tokens and visits).
- Tests that guard this: query count for 300 messages (`scale.e2e.test.ts`), history walk with cold cache, keyset paging with no repeats.

**Realtime**
- Socket.IO runs with the Redis adapter, so any number of server processes can serve one room, and groups have **no member limit**.
- 1:1 chat is delivered through each person's own `u:<id>` group (joined at connect). Never rely on a cross-server `socketsJoin` for time-critical delivery: with the Redis adapter it completes after a Redis round trip and early messages are lost.
- Register socket handlers synchronously on connection, before any `await`. A client may emit the instant it connects.
- Send flow: the client shows the message at once as "sending", the server acks with the sequence number, retries reuse the same `clientMsgId` (deduped). On reconnect the client sends `lastSeq` and receives exactly what it missed.
- Targets (tested locally): 95th percentile delivery under 50 ms, 60 listeners in one room all receive a message within 250 ms.

**Frontend (virtualization is mandatory)**
- Any list that can grow past about 30 items is **virtualised** (render only what is on screen): message lists, group feed and browse, member lists, every admin table. Use `@tanstack/react-virtual` (or `react-virtuoso` for chat).
- **Chat message list:** virtualised, anchored to the bottom, new messages auto-scroll only if the user is already at the bottom (otherwise show a "new messages" pill), scrolling up loads the previous page through `room:history` with scroll position preserved (no jump). Keep at most about 500 messages in memory per room and drop the oldest when far from view.
- **Feeds and tables:** infinite scroll or "load more" using the API cursor, with skeleton rows while loading. Never fetch "all".
- Messages are plain text, memoised row components, stable keys (`clientMsgId`), no layout shift. Use `content-visibility` and fixed row estimates where possible.
- Debounce search inputs (300 ms), throttle typing events (once per 2 s), and cancel stale requests.
- Public pages ship minimal JavaScript (Server Components); the socket client loads only in the signed-in app.

## 6. Admin console and analytics

### 6.1 Admin access (staff only)
- Lives at `/admin` in the frontend (`src/app/(admin)/`, feature code in `src/features/admin/`), `noindex`, never linked from public pages. Backed by `backend/src/modules/admin/` and `modules/analytics/`.
- **Separate from user accounts.** Table `admins`, own login endpoint, own cookie, own session lifetime (8h, no refresh). Admins are created by a CLI seed script only, never by public sign-up.
- **Mandatory 2FA (TOTP)** for every admin. Strict rate limit and lockout on the admin login. Roles: `owner` (everything, manages admins and campaigns), `moderator` (escalations and users), `analyst` (analytics only, no user records).
- **Every user record opened and every action taken is written to `admin_audit`** (append only). Admins cannot edit or delete audit rows.
- Admin API is a separate Fastify plugin with its own auth hook. Never reuse user JWTs for admin routes.

### 6.2 Admin screens
1. **Overview:** total users, new users (today / 7d / 30d), online now, active users, matches and average wait time, match success rate (chats lasting over 60s), groups created, messages sent, open reports. Time-range picker, comparison to the previous period, charts for trends.
2. **Escalations:** queue of reports and auto-escalations (review, suspended, banned), filter by status and reason, oldest first. Each item shows the reason, evidence snapshot, reporter count, and the reported account's history. Actions: dismiss, warn, suspend, ban, unban. Every action is audited.
3. **Users:** search and filter (email, username, gender, age, status, channel, date). A user detail page shows everything we store about that account: email, username, gender, date of birth and age, join date, last seen, verification, ban state, acquisition source and campaign, preferences, groups, blocks given and received, reports made and received, match count. Chat message content is shown only as saved report evidence, never browsable.
4. **Analytics:** acquisition and product performance (see 6.3).
5. **Campaigns:** UTM link builder and performance table (see 6.3).
6. **Admins and audit log** (owner only).
- Admin UI is desktop first but must stay usable on a tablet. Tables are virtualised, filterable, exportable to CSV (owner and analyst). Same design tokens and reusable components as the app; the `components/shared` data table, stat card and chart components are reused across every admin screen.

### 6.3 Traffic tracking, UTM and SEO
- **First party only.** No Google Analytics, no pixels, no third-party scripts. A tiny `POST /track/visit` call from the landing and public pages, once per session. The server classifies the visit (code in `analytics/attribution.ts`, tested), ignores bots, and stores no IP address and no fingerprint. Visitor id is a random first-party cookie id. Respect Do Not Track and Global Privacy Control by not setting the visitor cookie (count the visit as anonymous).
- **Channels:** `utm` (any utm_ tag wins, so shared links are never counted as organic), `seo` (search engine referrers), `llm` (ChatGPT, Perplexity, Claude, Gemini and similar referrers), `social`, `referral`, `direct`.
- **Campaign links:** owners create campaigns in the admin (name, source, medium, campaign, content, target page). Each gets a tagged URL and a short link `/r/<code>` that logs the click and redirects. Naming is normalised to lowercase so `Reddit` and `reddit` never split.
- **Attribution:** first-touch. On sign-up the user row stores channel, source and campaign from their visit, so we can report signups, not just visits, per link.
- **Analytics views:** visits, unique visitors, sign-ups and conversion rate by channel, source, medium and campaign; SEO traffic over time with the top landing pages and top search engines; LLM referral traffic; top campaigns; day-by-day trend; per-campaign funnel (visit, sign-up, first match). Retention (day 1, day 7) by channel.
- Privacy page must say what is counted, in plain words.

### 6.4 Honesty about staff access
- Staff can see account data (including email and date of birth) to keep the platform safe and run it. The privacy page and sign-up copy must say this plainly: other users never see it, and staff access is limited, 2FA protected and logged. Never promise that "nobody can see your data".
- 1:1 chat content is not retained after the chat ends, except report evidence. Staff cannot read live or past chats.

## 7. Security (OWASP Top 10, strict)

Security is a release gate. No feature ships if it breaks a rule here. Every rule below has a test or a named check; "done" includes that test.

- **A01 Broken access control:** deny by default. Every non-public route calls `requireUser` (or the admin hook) first. Resources are always looked up by the authenticated user's id, never by an id the client supplies alone (no IDOR). Test each route unauthenticated, as another user, and as a banned user. Admin routes use a separate auth hook, roles are checked server side.
- **A02 Cryptographic failures:** argon2id passwords, 256-bit random refresh tokens stored only as SHA-256 hashes, HS256 JWTs with secrets of 32+ chars. TLS everywhere in production, `Secure` + `HttpOnly` + `SameSite` cookies, HSTS. The server refuses to boot in production with weak or equal secrets or a non-https `WEB_ORIGIN`. Encrypt TOTP secrets at rest. Never log secrets, cookies or passwords (logger redaction is on).
- **A03 Injection:** Drizzle parameterised queries only. No string-built SQL, no `sql.raw` with input. Every request body, query, param and socket payload is parsed with a zod contract before use. Unknown fields are ignored (no mass assignment). Output encoding is React's default; never use `dangerouslySetInnerHTML` with user text. Chat text is plain text only.
- **A04 Insecure design:** rate limits on every write path (auth, messages, group create, report, match join); per-account and per-IP failed-login throttle (Redis); abuse limits (3 groups/hour, message flood limit); 18+ rule enforced in three layers; ephemeral chats; threat-model new features before building.
- **A05 Misconfiguration:** `helmet` with a strict CSP on the API, a CSP on the frontend (no inline scripts, nonces for what is needed), CORS limited to the exact web origin, request body limit 16 KB, only JSON accepted, generic error messages (no stack traces), `TRUST_PROXY` off unless behind our own proxy (otherwise IPs are spoofable). No debug routes in production. `.env` never committed.
- **A06 Vulnerable components:** `npm audit --omit=dev` must report 0 before any release; lockfiles committed; update dependencies monthly; add new packages only when needed and check them first.
- **A07 Authentication failures:** generic login error and equal timing for unknown emails; lockout after 5 failures per email+IP and 20 per email in 15 min; refresh token rotation with **reuse detection** (a replayed token revokes every session of that user); short access tokens (15 min); logout revokes; banned users are rejected on login and on every session check; mandatory TOTP for admins.
- **A08 Software and data integrity:** CI runs typecheck, tests and audit on every change; migrations only through drizzle-kit and reviewed; no `eval`, no dynamic `require` of user input; verify any third-party script (there should be none).
- **A09 Logging and monitoring:** log auth failures, lockouts, bans, reports, admin actions (audit table) with request ids, never secrets. Alert on spikes of failed logins, 5xx and reports.
- **A10 SSRF:** the server never fetches a URL supplied by a user. No link previews, no image proxying, no webhooks to user URLs. Campaign redirects (`/r/:code`) only redirect to a stored relative path, never to a user-supplied URL (no open redirect).
- **CSRF:** `SameSite=Lax` cookies plus an Origin check on every state-changing request plus JSON-only bodies.
- **Sockets:** authenticate during the handshake (cookie), verify the Origin header, validate every payload with zod, rate limit per socket, authorise room membership on every join and send, cap message size, disconnect on repeated invalid events.
- **Frontend:** tokens live only in httpOnly cookies, never in localStorage. No secrets in `NEXT_PUBLIC_` variables. Security headers set in `next.config`. Treat all data from the API as untrusted when rendering.
- **Privacy as security:** return the minimum fields (use explicit `toSelf`/`toPeer` mappers, never return a raw DB row). Other users only ever get alias, gender and age. API responses are checked in tests for leaked fields.
- **Honest limit:** no system is "unhackable". We reduce risk with layered controls, tests and monitoring, and we say so in copy. Before launch run a dependency audit, a secrets scan, and an external review or penetration test.

## 8. SEO, discoverability and LLM optimisation

Next.js is used so public pages are server rendered and easy to discover. Rules:

- Public, indexable pages: landing, how it works, safety/anonymity promise, privacy, terms, FAQ, and **topic pages** (e.g. `/topics/football`) that list public group titles and topics only. **Never** put chat messages, aliases or user data on an indexable page.
- App pages (`/home`, `/chat`, `/groups/*`, `/me`, auth) are `noindex, nofollow` via metadata and `robots.ts`.
- Every public page exports `generateMetadata` with unique title (under 60 chars), description (under 160), canonical URL, Open Graph and Twitter card. OG images generated with `next/og`, not stored media.
- Ship `app/sitemap.ts`, `app/robots.ts`, and **`/llms.txt`** (plus `/llms-full.txt`) describing what Anonmee is, what it does and does not collect, and the key pages, so LLM crawlers answer accurately.
- JSON-LD structured data: `WebApplication` and `Organization` on landing, `FAQPage` on the FAQ, `BreadcrumbList` on topic pages. Content in JSON-LD must match visible content.
- Semantic HTML: one `h1` per page, ordered headings, landmarks, descriptive link text, `lang` on `<html>`, alt text on any real image.
- **Text tagging:** group topics are normalised lowercase tags (slug, 2-24 chars, max 5 per group). Tags power interest ranking, topic pages, search and SEO keywords. Keep one canonical tag list with synonyms mapped (for example "soccer" to "football").
- Performance is an SEO feature: LCP under 2.5s, CLS under 0.1, INP under 200ms, `next/font`, `next/image` for real images, lazy-load below-the-fold motion, minimal client JS on public pages (Server Components first).

## 9. Design system and UI rules

**Design read:** consumer social app for Gen Z and young adults 18-30, mostly on phones, used at night. Funky, loud, social-proof and FOMO driven, but honest about privacy. Both themes are designed; the loud colour bands carry the brand.

**Dials (taste-skill):** `DESIGN_VARIANCE 7`, `MOTION_INTENSITY 7`, `VISUAL_DENSITY 3` on the landing page. App screens (home, chat, groups) use `VARIANCE 4`, `MOTION 5`, `DENSITY 5`: calm, fast, legible.

### Components
- **Spectrum UI is the component source** (`@spectrumui` shadcn registry, also available as the `spectrum-ui` MCP: search with `search_components`, install with `bunx --bun shadcn@latest add @spectrumui/<name>`, or `npx shadcn@latest add @spectrumui/<name>` here). Check Spectrum UI first for every component before writing one by hand.
- Customise every installed component to the Anonmee tokens. Never ship default state.
- One icon family: **Phosphor** (`@phosphor-icons/react`), one stroke weight. No hand-drawn SVG icons. No emoji in UI chrome (chat messages may contain user emoji).

### Look and feel (locked, set by the owner: funky, loud, Gen Z, FOMO, not AI-looking)
- **Style: sticker sheet.** Chunky outlines (`border-2 border-edge`), solid offset shadows with no blur (`shadow-sticker`), slightly tilted stickers, big heavy headlines, flat colour bands, a phone bezel for showing the product. Curves are welcome (pills, `rounded-card` 28px, `rounded-ui` 16px).
- **Banned because it looks AI-made:** gradients and glows, blurred shadows, eyebrow labels, numbered "01 02 03" steps, three equal feature cards, icon tiles in a bento, generic circular avatars with a glow, "trusted by" filler, fake stats, stock photos, hand-drawn SVG icons, emoji in UI chrome. Never reintroduce the first dark-and-rose template look.
- **Colour (three, each with one job; defined in `styles/tokens.css`):** cobalt `--brand` for hero and call-to-action bands and your own chat bubbles; **peach `--accent`** for the main action (buttons, selected tags, live things); coral-rose `--pop` for highlights, stamps and sticker labels. Ink and off-white do the rest. Never use lime or green as an accent (green is only the `--success` state colour). No pure `#000` or `#fff`.
- **Theme:** dark and light both designed and tested; follows the system until the person chooses; `--edge` (outline and shadow colour) flips with the theme. The page theme never flips mid-page. Bands that are always one colour (`bg-ink`, `bg-brand`, `bg-pop`) are deliberate.
- **Radius:** buttons and tags are pills (`rounded-full`), inputs and small blocks `rounded-ui`, cards and sheets `rounded-card`. Do not invent other radii.
- **Type:** headlines are Archivo, heavy and condensed (`.display`, width axis 78%), body Geist, numbers and metadata Geist Mono. `next/font` only. No Inter, no serif.
- **Components come from `components/ui` and `components/shared`** (Button, Chip, TextField, CheckboxField, Sheet, Skeleton, NumberTicker, AliasAvatar, PeerBadge, MessageBubble, TypingDots, OnlineCounter, EmptyState, ErrorState, RedactionBar). Reuse them; never restyle one inline. Spectrum UI components are installed, then adapted to these tokens and to Phosphor icons.
- **FOMO must be real.** The live ticker and counters show only true data from `/stats/pulse` and the public socket (people online, chats started today, "someone just matched", a new public group title) mixed with true facts about the app. No invented numbers, no fake countdowns, no fake "X people are looking at this".

### Mobile-first layout rules
- Design at 375px width first, then scale up. Verify at 360, 390, 430, 768, 1024, 1440.
- Use `min-h-[100dvh]`, never `h-screen`. Respect safe areas (`env(safe-area-inset-*)`), especially for chat input and bottom nav.
- **Touch targets at least 44x44px.** Primary buttons 48-56px tall, full width on mobile. Spacing between tappable items at least 8px.
- **Body text at least 16px on inputs** (prevents iOS zoom on focus), 15-17px for messages, never below 12px anywhere. Line height 1.4-1.6.
- Chat screen: header (peer alias, Report/Leave menu), scrollable message list, composer pinned above the keyboard (use `100dvh` and `visualViewport`). Messages max-width 80% on mobile, 65ch on desktop. Own messages right, others left.
- Mobile navigation: bottom tab bar (Home, Chat, Groups, Me). Desktop: left rail plus content, chat gets a split view (list left, conversation right).
- Primary action of a screen is always one obvious button in the thumb zone. Never two same-intent CTAs on one screen. CTA labels fit on one line (max 3 words).
- Forms: label above input, helper text present, error text below, no placeholder-as-label, visible focus ring, WCAG AA contrast on all text and controls.
- Hero fits the first viewport on a small laptop (about 1366x650) and on a 375x667 phone: headline max 2 lines on desktop, sub copy max 20 words, one primary CTA visible without scrolling. The phone mock may extend below the fold.
- Every async view has loading (skeleton matching the layout), empty and error states.

### Motion
- Library: `motion/react`. GSAP only for scroll pinning on the landing page, isolated in leaf client components with cleanup. Do not mix them in one tree.
- Animate `transform` and `opacity` only. Every motion above intensity 3 must honour `prefers-reduced-motion`.
- Motion must mean something (hierarchy, feedback, state change). No `window.addEventListener("scroll")`. No state-driven pointer physics, use motion values.
- Landing page must feel stunning and alive: cobalt hero with a tilted phone that plays a real conversation (typing indicator, then the message), stickers that follow the pointer, the live ticker (the one marquee; pauses on hover; static under reduced motion), a working intent picker, a match-found moment, a privacy slip whose redaction bars draw themselves on scroll, wiggling topic stickers.

### Copy rules
- No em-dashes or en-dashes anywhere in user-visible copy. Use hyphen, comma, colon or a new sentence.
- Banned words: elevate, seamless, unleash, next-gen, revolutionize. No fake stats; real numbers come from the live counter or are omitted.
- Tone: warm, direct, short. Reassure without overclaiming ("We never show your email or username to anyone", not "unbreakable security").
- Landing page sections should use at least four different layout families. Max one eyebrow label per three sections.

## 10. Code conventions

- Server Components by default in Next.js. Anything with Motion, sockets or pointer logic is an isolated `"use client"` leaf.
- Shared validation: one zod schema per payload in the contracts folder, reused by forms (react-hook-form) and server.
- Socket state lives in a single provider; components never create their own sockets.
- Naming: `kebab-case` files, `PascalCase` components, `camelCase` functions. Match surrounding code for comment density (comments explain why, not what).
- Check `package.json` before importing any library; install first if missing.
- Tests: Vitest for shared and server logic (matching, auth, rate limits), Playwright for the sign-up, match and group-join flows. A feature is not done without its test.
- Never commit `.env`. Keep `.env.example` current.
- **Next.js here is v16 with Cache Components on** (`cacheComponents: true`). It differs from older versions: before writing routing, caching, metadata or auth code, read the matching guide in `frontend/node_modules/next/dist/docs/01-app/`. Dynamic data (cookies, headers, per-user fetches) must sit inside `<Suspense>` or be cached with `use cache`; public marketing pages stay fully static.
- **Signed-in screens opt out of instant-navigation validation** with `export const instant = false` in `src/app/(session)/layout.tsx`: the session is only known in the browser, so the server cannot pre-render them (otherwise the dev overlay reports the pages as "dropped"). Public marketing pages stay fully static and must keep passing validation.
- **zod is pinned to v3 in both projects** so the contract files are identical. Do not add `@hookform/resolvers` (peer conflicts); use the small `zodResolver` helper in `frontend/src/lib/forms.ts`.
- Run `npm run sync:contracts` in `frontend/` after any change to `backend/src/contracts`.

## 11. Definition of done for any screen

1. Looks right at 360 / 390 / 768 / 1440, in light and dark.
2. Touch targets, font sizes and safe-area rules in section 9 pass.
3. Loading, empty, error states exist.
4. Reduced-motion tested.
5. Nothing identifying leaks in the UI or API payloads (check network tab), and the security rules in section 7 hold for the new code, with tests.
6. Typecheck, lint and tests pass.

## 12. Build order

1. Scaffold the backend and frontend projects, env validation, Drizzle schema. (DONE for the backend: auth, preferences, matching, 1:1 chat, global and group chat, report/block, tracking, admin API, retention. 113 tests.)
2. Auth (register in under a minute, login, session) with the 18+ check.
3. Landing page (the stunning one) with live online counter, plus SEO files (sitemap, robots, llms.txt, JSON-LD).
4. Presence + online counter over Socket.IO + Redis.
5. Preferences + random 1:1 matching + chat + report/block.
6. Global chat.
7. Groups: create, list, interest-ranked Home, join, chat.
8. Moderation hooks, rate limits, retention jobs, hardening, deployment config.
9. Admin console: admin auth with 2FA and audit log, escalations, users, analytics, UTM campaigns.
