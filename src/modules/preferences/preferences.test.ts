import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../app";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { INTENT_GROUPS, INTENTS, groupOfIntent, intentGroupSummary } from "../../contracts";
import { makeUser } from "../../test/helpers";

let app: FastifyInstance;
const TAG = "preftest";
beforeAll(async () => {
  app = await buildApp(db);
});
afterAll(async () => {
  await db.delete(users).where(eq(users.email, `${TAG}-a@example.com`));
  await app.close();
});

const base = { wantGenders: ["female", "trans_woman"], minAge: 21, maxAge: 40, interests: ["music"] };
const put = (cookie: string, body: unknown) => app.inject({ method: "PUT", url: "/preferences", payload: body as object, headers: { cookie } });

describe("preferences", () => {
  it("saves specific relationship options and trans gender choices, and reads them back", async () => {
    const u = await makeUser(app, TAG, "a", { gender: "trans_man" });
    const res = await put(u.cookie, { ...base, intents: ["friendship", "sexting", "friends_with_benefits"] });
    expect(res.statusCode).toBe(200);
    const got = (await app.inject({ method: "GET", url: "/preferences", headers: { cookie: u.cookie } })).json().preferences;
    expect(got.intents.sort()).toEqual(["friends_with_benefits", "friendship", "sexting"]);
    expect(got.wantGenders.sort()).toEqual(["female", "trans_woman"]);
  });

  it("refuses unknown or retired options and empty choices", async () => {
    const u = await makeUser(app, TAG, "a2", { gender: "female" });
    expect((await put(u.cookie, { ...base, intents: ["friends"] })).statusCode).toBe(400);
    expect((await put(u.cookie, { ...base, intents: ["not_a_thing"] })).statusCode).toBe(400);
    expect((await put(u.cookie, { ...base, intents: [] })).statusCode).toBe(400);
    expect((await put(u.cookie, { ...base, intents: ["sexting"], wantGenders: ["alien"] })).statusCode).toBe(400);
    await db.delete(users).where(eq(users.email, `${TAG}-a2@example.com`));
  });

  it("groups every option and keeps public summaries coarse", () => {
    expect(INTENTS.length).toBe(INTENT_GROUPS.flatMap((g) => g.intents).length);
    expect(groupOfIntent("sexting")).toBe("relationships");
    expect(groupOfIntent("friendship")).toBe("friendship");
    expect(intentGroupSummary(["sexting", "one_night_stand", "friendship"])).toEqual(["friendship", "dating and relationships"]);
  });
});
