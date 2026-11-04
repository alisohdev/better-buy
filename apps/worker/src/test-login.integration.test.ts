import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { api } from "./index";

const databases: DatabaseSync[] = [];
const origin = "http://127.0.0.1:8787";
function devHeaders(path: string, body: string, timestamp = Date.now()) {
  const time = String(timestamp);
  return {
    "content-type": "application/json",
    "x-better-buy-dev": "wishlist",
    "x-better-buy-dev-time": time,
    "x-better-buy-dev-signature": createHmac(
      "sha256",
      "local-integration-secret-at-least-32-characters"
    )
      .update(`better-buy-dev-wishlist-v1\n${time}\nPOST\n${path}\n${body}`)
      .digest("hex"),
  };
}
function setup(devMode = "true", appOrigin = origin) {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  for (const file of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    sqlite.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8")
    );
  }
  function statement(sql: string, args: SQLInputValue[] = []) {
    return {
      bind: (...values: SQLInputValue[]) => statement(sql, values),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({
        results: sqlite.prepare(sql).all(...args),
        success: true,
        meta: {},
      }),
      run: async () => ({
        success: true,
        meta: sqlite.prepare(sql).run(...args),
      }),
    };
  }
  const db = {
    prepare: (sql: string) => statement(sql),
    exec: async (sql: string) => sqlite.exec(sql),
    batch: async (statements: ReturnType<typeof statement>[]) =>
      Promise.all(statements.map((s) => s.all())),
  } as unknown as D1Database;
  const env = {
    DB: db,
    ASSETS: {} as Fetcher,
    BOX_KEY: "local-integration-box-key",
    BETTER_AUTH_SECRET: "local-integration-secret-at-least-32-characters",
    BETTER_AUTH_URL: origin,
    APP_ORIGIN: appOrigin,
    CORS_ORIGIN: appOrigin,
    GOOGLE_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fixture",
    DEV_MODE: devMode,
  };
  const request = (path: string, init?: RequestInit) =>
    api.fetch(new Request(origin + path, init), env);
  return { sqlite, request, env };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("development login with the real Better Auth session reader", () => {
  it("protects browser scan commands with development mode, session and origin", async () => {
    const headers = {
      Origin: origin,
      "content-type": "application/json",
      "x-better-buy-dev": "wishlist-ui",
    };
    const disabled = setup("false");
    expect(
      (
        await disabled.request("/api/wishlist/dev-scan/start", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status
    ).toBe(404);
    const fixture = setup();
    expect(
      (
        await fixture.request("/api/wishlist/dev-scan/start", {
          method: "POST",
          headers: { ...headers, Origin: "https://untrusted.example" },
          body: "{}",
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fixture.request("/api/wishlist/dev-scan/start", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status
    ).toBe(401);
    const login = await fixture.request("/api/auth/test-login", {
      method: "POST",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const authHeaders = { ...headers, cookie };
    const ownSession = await fixture.request("/api/auth/get-session", {
      headers: { cookie },
    });
    const owner = ((await ownSession.json()) as { user: { id: string } }).user
      .id;
    const now = new Date().toISOString();
    Object.assign(fixture.env, {
      SNAPP_STORE_CAMPAIGNS_ENABLED: "true",
      SCAN_WORKFLOW: {
        get: async () => {
          throw Object.assign(new Error("missing"), { status: 404 });
        },
        create: async () => ({ status: async () => ({ status: "running" }) }),
      },
    });
    const body = { source: "snappmarket", key: crypto.randomUUID() };
    expect(
      (
        await fixture.request("/api/wishlist/dev-scan/start", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ ...body, userId: "other" }),
        })
      ).status
    ).toBe(400);
    expect(
      (
        await fixture.request("/api/wishlist/dev-scan/start", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body),
        })
      ).status
    ).toBe(409);
    const location = fixture.sqlite
      .prepare("SELECT id FROM locations WHERE user_id=?")
      .get(owner)!;
    if (typeof location.id !== "string")
      throw new Error("Missing test location");
    fixture.sqlite
      .prepare(
        "INSERT INTO wishlist_preferences(user_id,default_location_id,updated_at) VALUES(?,?,?)"
      )
      .run(owner, location.id, now);
    fixture.sqlite
      .prepare(
        "INSERT INTO wishlist_items(id,user_id,phrase,normalized_phrase,tokens_json,created_at) VALUES(?,?,?,?,?,?)"
      )
      .run("own-wish", owner, "milk", "milk", '["milk"]', now);
    const response = await fixture.request("/api/wishlist/dev-scan/start", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    const result = (await response.json()) as { data: { scanId: string } };
    expect(
      fixture.sqlite
        .prepare("SELECT user_id,mode,threshold FROM scans WHERE id=?")
        .get(result.data.scanId)
    ).toMatchObject({ user_id: owner, mode: "full", threshold: 40 });
    expect(
      fixture.sqlite
        .prepare(
          "SELECT enrichment_enabled FROM scan_execution WHERE scan_id=?"
        )
        .get(result.data.scanId)
    ).toMatchObject({ enrichment_enabled: 1 });
  });
  it("exposes the manual wishlist scan only to authenticated signed development commands", async () => {
    const disabled = setup("false");
    expect(
      (
        await disabled.request("/api/dev/wishlist/start", {
          method: "POST",
          headers: devHeaders("/api/dev/wishlist/start", "{}"),
          body: "{}",
        })
      ).status
    ).toBe(404);
    const local = setup();
    expect(
      (await local.request("/api/dev/wishlist/start", { method: "POST" }))
        .status
    ).toBe(404);
    expect(
      (
        await local.request("/api/dev/wishlist/start", {
          method: "POST",
          headers: {
            ...devHeaders("/api/dev/wishlist/start", "{}"),
            Origin: "https://other.example",
          },
          body: "{}",
        })
      ).status
    ).toBe(404);
    expect(
      (
        await local.request("/api/dev/wishlist/start", {
          method: "POST",
          headers: devHeaders("/api/dev/wishlist/start", "{}"),
          body: "{}",
        })
      ).status
    ).toBe(401);
    expect(
      (
        await local.request("/api/dev/wishlist/start", {
          method: "POST",
          headers: devHeaders(
            "/api/dev/wishlist/start",
            "{}",
            Date.now() - 61_000
          ),
          body: "{}",
        })
      ).status
    ).toBe(404);
    expect(
      (
        await local.request("/api/dev/wishlist/start", {
          method: "POST",
          headers: devHeaders("/api/dev/wishlist/start", "{}"),
          body: '{"userId":"changed"}',
        })
      ).status
    ).toBe(404);
    const remote = await api.fetch(
      new Request("https://example.com/api/dev/wishlist/start", {
        method: "POST",
        headers: { "x-better-buy-dev": "wishlist" },
      }),
      local.env
    );
    expect(remote.status).toBe(404);
  });

  it.each([
    { marketPartyOnly: false, expectedEnrichment: 1 },
    { marketPartyOnly: true, expectedEnrichment: 0 },
  ])(
    "starts a real durable scan for the selected local user only (marketPartyOnly=$marketPartyOnly)",
    async ({ marketPartyOnly, expectedEnrichment }) => {
      const { sqlite, request, env } = setup();
      const login = await request("/api/auth/test-login", { method: "POST" });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const target = "target-user";
      const now = new Date().toISOString();
      sqlite
        .prepare(
          'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
        )
        .run(target, "Target", "target@example.test", 1, now, now);
      sqlite
        .prepare(
          "INSERT INTO locations(id,user_id,name,latitude,longitude,is_default,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
        )
        .run("target-home", target, "Home", 35.7, 51.4, 1, now, now);
      sqlite
        .prepare(
          "INSERT INTO wishlist_preferences(user_id,default_location_id,updated_at) VALUES(?,?,?)"
        )
        .run(target, "target-home", now);
      sqlite
        .prepare(
          "INSERT INTO wishlist_items(id,user_id,phrase,normalized_phrase,tokens_json,created_at) VALUES(?,?,?,?,?,?)"
        )
        .run("target-wish", target, "milk", "milk", '["milk"]', now);
      const instance = { status: async () => ({ status: "running" }) };
      Object.assign(env, {
        WISHLIST_SCHEDULE_ENABLED: "false",
        SNAPP_STORE_CAMPAIGNS_ENABLED: "true",
        SCAN_WORKFLOW: {
          get: async () => {
            throw Object.assign(new Error("missing"), { status: 404 });
          },
          create: async () => instance,
        },
      });
      const startBody = JSON.stringify({
        userId: target,
        source: "snappmarket",
        key: crypto.randomUUID(),
        marketPartyOnly,
      });
      const response = await request("/api/dev/wishlist/start", {
        method: "POST",
        headers: {
          ...devHeaders("/api/dev/wishlist/start", startBody),
          cookie,
        },
        body: startBody,
      });
      expect(response.status).toBe(202);
      const result = (await response.json()) as { data: { scanId: string } };
      const scan = sqlite
        .prepare(
          "SELECT user_id,location_id,source,mode,threshold FROM scans WHERE id=?"
        )
        .get(result.data.scanId);
      expect(scan).toMatchObject({
        user_id: target,
        location_id: "target-home",
        source: "snappmarket",
        mode: "full",
        threshold: 40,
      });
      expect(
        sqlite
          .prepare(
            "SELECT enrichment_enabled FROM scan_execution WHERE scan_id=?"
          )
          .get(result.data.scanId)
      ).toMatchObject({ enrichment_enabled: expectedEnrichment });
      const statusBody = JSON.stringify({
        userId: "other-user",
        scanId: result.data.scanId,
      });
      const other = await request("/api/dev/wishlist/status", {
        method: "POST",
        headers: {
          ...devHeaders("/api/dev/wishlist/status", statusBody),
          cookie,
        },
        body: statusBody,
      });
      expect(other.status).toBe(404);
      const browserOther = await request("/api/wishlist/dev-scan/status", {
        method: "POST",
        headers: {
          cookie,
          Origin: origin,
          "content-type": "application/json",
          "x-better-buy-dev": "wishlist-ui",
        },
        body: JSON.stringify({ scanId: result.data.scanId }),
      });
      expect(browserOther.status).toBe(404);
      const missingBody = JSON.stringify({
        userId: "other-user",
        source: "okala",
        key: crypto.randomUUID(),
      });
      const missing = await request("/api/dev/wishlist/start", {
        method: "POST",
        headers: {
          ...devHeaders("/api/dev/wishlist/start", missingBody),
          cookie,
        },
        body: missingBody,
      });
      expect(missing.status).toBe(409);
    }
  );
  it("allows split-dev browsers to read login and session responses", async () => {
    const appOrigin = "http://127.0.0.1:3000";
    const { request } = setup("true", appOrigin);
    const login = await request("/api/auth/test-login", {
      method: "POST",
      headers: { Origin: appOrigin },
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(login.headers.get("access-control-allow-credentials")).toBe("true");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await request("/api/auth/get-session", {
      headers: { Origin: appOrigin, cookie },
    });
    expect(session.status).toBe(200);
    expect(session.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(session.headers.get("access-control-allow-credentials")).toBe(
      "true"
    );
    expect(await session.json()).not.toBeNull();
  });

  it("allows development login preflight only for the configured origin", async () => {
    const appOrigin = "http://127.0.0.1:3000";
    const { request } = setup("true", appOrigin);
    const preflight = await request("/api/auth/test-login", {
      method: "OPTIONS",
      headers: {
        Origin: appOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      appOrigin
    );
    const rejected = await request("/api/auth/get-session", {
      headers: {
        Origin: "https://untrusted.example",
      },
    });
    expect(rejected.headers.has("access-control-allow-origin")).toBe(false);
    expect(rejected.headers.has("access-control-allow-credentials")).toBe(
      false
    );
  });

  it("accepts the issued browser cookie for session reads and protected application routes", async () => {
    const { request } = setup();
    const login = await request("/api/auth/test-login", { method: "POST" });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const session = await request("/api/auth/get-session", {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      user: { id: string };
      session: { userId: string };
    };
    expect(body).not.toBeNull();
    expect(body.session.userId).toBe(body.user.id);
    const me = await request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ data: { id: body.user.id } });
  });

  it("rejects a tampered cookie and requests without a session", async () => {
    const { request } = setup();
    const login = await request("/api/auth/test-login", { method: "POST" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const [name, value] = [
      cookie.slice(0, cookie.indexOf("=")),
      cookie.slice(cookie.indexOf("=") + 1),
    ];
    const tampered = `${name}=${encodeURIComponent("tampered." + decodeURIComponent(value).split(".").at(-1))}`;
    const session = await request("/api/auth/get-session", {
      headers: { cookie: tampered },
    });
    expect(await session.json()).toBeNull();
    expect(
      (await request("/api/me", { headers: { cookie: tampered } })).status
    ).toBe(401);
    expect((await request("/api/me")).status).toBe(401);
  });

  it("keeps development login unavailable when DEV_MODE is disabled", async () => {
    const { request, sqlite } = setup("false");
    const login = await request("/api/auth/test-login", { method: "POST" });
    expect(login.status).toBe(404);
    expect(login.headers.has("set-cookie")).toBe(false);
    expect(
      sqlite.prepare('SELECT count(*) AS count FROM "user"').get()!.count
    ).toBe(0);
  });
});
