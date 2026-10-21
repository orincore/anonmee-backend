# Anonmee backend

Node, Fastify, Socket.IO, Drizzle (Postgres) and Redis. See CLAUDE.md for the rules.

```
cp .env.example .env   # then fill in real secrets
npm ci
npx drizzle-kit migrate
npm run start
```
