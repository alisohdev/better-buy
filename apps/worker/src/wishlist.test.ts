import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { Api, WorkerEnv } from "./http/types";
import { registerWishlist } from "./http/wishlist";
import { registerDevWishlist } from "./http/dev-wishlist";
import { matchesWishlist, wishlistTokens } from "./wishlist-matching";
import {
  processWishlistNotifications,
  notifyWishlistScan,
  readNotifications,
} from "./wishlist";
import {
  drainPushDeliveries,
  isPushEndpoint,
  savePushSubscription,
} from "./wishlist-push";
import { readProductPage } from "./saved-products";

const databases: DatabaseSync[] = [];
function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url))
    .filter((name) => name.endsWith(".sql") && !name.startsWith("0005"))
    .sort())
    sqlite.exec(
      readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8")
    );
  sqlite
    .prepare(
      "INSERT INTO locations(id,user_id,name,latitude,longitude,created_at,updated_at) VALUES('home','owner','Home',35.7,51.4,'2026-10-01','2026-10-01')"
    )
    .run();
  const prepare = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...args: SQLInputValue[]) => prepare(sql, args),
    first: async () => sqlite.prepare(sql).get(...values) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({ meta: sqlite.prepare(sql).run(...values) }),
  });
  const db = {
    prepare,
    batch: async (statements: { run(): Promise<unknown> }[]) => {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const env = { DB: db, BOX_KEY: "test-key" } as WorkerEnv;
  const app: Api = new Hono();
  app.use("*", async (context, next) => {
    context.set("userId", context.req.header("x-user") ?? "owner");
    await next();
  });
  registerWishlist(app);
  registerDevWishlist(app);
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    user = "owner"
  ) =>
    app.request(
      "https://test/api/" + path,
      {
        method,
        headers: { "content-type": "application/json", "x-user": user },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env
    );
  const item = (phrase = "پنیر خامه ای", user = "owner") => {
    const id = crypto.randomUUID();
    sqlite
      .prepare("INSERT INTO wishlist_items VALUES(?,?,?,?,?,?)")
      .run(
        id,
        user,
        phrase,
        phrase,
        JSON.stringify(wishlistTokens(phrase)),
        "2026-10-01T00:00:00.000Z"
      );
    return id;
  };
  const scan = (
    id = "scan",
    price = 50000,
    status = "succeeded",
    title = "پنیر خامه‌ای برند"
  ) => {
    sqlite
      .prepare(
        "INSERT INTO scans(id,user_id,location_id,threshold,source,mode,status,created_at,finished_at) VALUES(?,'owner','home',40,'snappmarket','full',?,'2026-10-26T10:00:00.000Z','2026-10-26T10:01:00.000Z')"
      )
      .run(id, status);
    sqlite
      .prepare(
        "INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,vendor_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock) VALUES(?,?,'store:product','product','store',?,'Store',100000,?,?,?,3)"
      )
      .run(
        id + "deal",
        id,
        title,
        100000 - price,
        price,
        (100000 - price) / 1000
      );
  };
  return { sqlite, db, env, request, item, scan };
}
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("wishlist", () => {
  it("returns a real per-scan notification to the development command", async () => {
    const fixture = fixtureForTest();
    const scanId = crypto.randomUUID();
    fixture.item();
    fixture.scan(scanId);
    Object.assign(fixture.env, { SCAN_WORKFLOW: {} });
    const response = await fixture.request("dev/wishlist/status", "POST", {
      userId: "owner",
      scanId,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      data: {
        status: string;
        notification: { id: string; matches: unknown[] };
        push: string;
      };
    };
    expect(result.data.status).toBe("succeeded");
    expect(result.data.notification.id).toBe("wishlist:" + scanId);
    expect(result.data.notification.matches).toHaveLength(1);
    expect(result.data.push).toBe("unconfigured");
    const repeated = await fixture.request("dev/wishlist/status", "POST", {
      userId: "owner",
      scanId,
    });
    expect(repeated.status).toBe(200);
    expect(await readNotifications(fixture.db, "owner")).toHaveLength(1);
  });
  it("normalizes Persian letters, half-spaces and numbers without matching missing words", () => {
    expect(matchesWishlist("پنير خامه‌ای ۵۰۰ گرمی", "پنیر خامه اي 500")).toBe(
      true
    );
    expect(matchesWishlist("پنیر پیتزا", "پنیر خامه ای")).toBe(false);
    expect(matchesWishlist("تن ماهی", "")).toBe(false);
  });
  it("isolates keyword CRUD, default location and inbox by account", async () => {
    const fixture = fixtureForTest();
    expect(
      (await fixture.request("wishlist", "POST", { phrase: "پنیر خامه‌ای" }))
        .status
    ).toBe(201);
    expect(
      (await fixture.request("wishlist", "POST", { phrase: "پنير خامه اي" }))
        .status
    ).toBe(201);
    const data = (await (await fixture.request("wishlist")).json()) as {
      data: { items: { id: string }[] };
    };
    expect(data.data.items).toHaveLength(1);
    expect(
      (
        await fixture.request(
          "wishlist/location",
          "PUT",
          { locationId: "home" },
          "other"
        )
      ).status
    ).toBe(404);
    expect(
      (
        await fixture.request("wishlist/location", "PUT", {
          locationId: "home",
        })
      ).status
    ).toBe(200);
    await fixture.request(
      "wishlist/" + data.data.items[0]!.id,
      "DELETE",
      undefined,
      "other"
    );
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) count FROM wishlist_items").get()
        ?.count
    ).toBe(1);
    expect(
      (await fixture.request("wishlist", "POST", { phrase: "a" })).status
    ).toBe(400);
    expect(
      await (
        await fixture.request("notifications", "GET", undefined, "other")
      ).json()
    ).toEqual({ data: [] });
  });
  it("prioritizes matches across pages and rejects cursors after wishlist edits", async () => {
    const fixture = fixtureForTest();
    fixture.scan();
    fixture.sqlite
      .prepare(
        "INSERT INTO deals(id,scan_id,deal_key,product_variation_id,vendor_id,title,vendor_title,price_rials,discount_rials,final_price_rials,discount_ratio,stock) VALUES('other','scan','store:other','other','store','Other','Store',100000,90000,10000,90,3)"
      )
      .run();
    const itemId = fixture.item();
    const page = await readProductPage(fixture.db, "owner", "scan", {
      limit: "1",
      sort: "wishlist",
    });
    expect(page.items[0]!.title).toBe("پنیر خامه‌ای برند");
    expect(page.nextCursor).toBeTruthy();
    const next = await readProductPage(fixture.db, "owner", "scan", {
      limit: "1",
      sort: "wishlist",
      cursor: page.nextCursor!,
    });
    expect(next.items[0]!.title).toBe("Other");
    for (const sort of ["discount", "price"]) {
      const sorted = await readProductPage(fixture.db, "owner", "scan", {
        sort,
      });
      expect(sorted.items[0]!.title).toBe("Other");
    }
    const legacyDefault = await readProductPage(
      fixture.db,
      "owner",
      "scan",
      {}
    );
    expect(legacyDefault.items[0]!.title).toBe("Other");
    await expect(
      readProductPage(fixture.db, "owner", "scan", {
        sort: "price",
        cursor: page.nextCursor!,
      })
    ).rejects.toThrow("INVALID_CURSOR");
    fixture.sqlite.prepare("DELETE FROM wishlist_items WHERE id=?").run(itemId);
    await expect(
      readProductPage(fixture.db, "owner", "scan", {
        sort: "wishlist",
        cursor: page.nextCursor!,
      })
    ).rejects.toThrow("INVALID_CURSOR");
    const emptyWishlist = await readProductPage(fixture.db, "owner", "scan", {
      sort: "wishlist",
    });
    expect(emptyWishlist.items[0]!.title).toBe("Other");
  });
  it("notifies once for a new match and again only when its observed price falls", async () => {
    const fixture = fixtureForTest();
    fixture.item();
    fixture.scan();
    await notifyWishlistScan(fixture.db, "owner", "scan");
    await notifyWishlistScan(fixture.db, "owner", "scan");
    expect(await readNotifications(fixture.db, "owner")).toHaveLength(1);
    fixture.scan("same", 50000);
    await notifyWishlistScan(fixture.db, "owner", "same");
    expect(await readNotifications(fixture.db, "owner")).toHaveLength(1);
    fixture.scan("cheaper", 40000);
    await notifyWishlistScan(fixture.db, "owner", "cheaper");
    expect(await readNotifications(fixture.db, "owner")).toHaveLength(2);
    await fixture.request(
      "notifications/wishlist:scan/read",
      "POST",
      {},
      "other"
    );
    expect(
      (await readNotifications(fixture.db, "owner")).find(
        (notification) => notification.scanId === "scan"
      )?.readAt
    ).toBeNull();
    await fixture.request("notifications/wishlist:scan/read", "POST", {});
    expect(
      (await readNotifications(fixture.db, "owner")).find(
        (notification) => notification.scanId === "scan"
      )?.readAt
    ).toBeTruthy();
  });
  it("does not notify failed scans or scans older than wishlist enrollment", async () => {
    const fixture = fixtureForTest();
    fixture.item();
    fixture.scan("failed", 50000, "failed");
    fixture.scan("old");
    fixture.sqlite
      .prepare("UPDATE scans SET created_at='2026-09-01' WHERE id='old'")
      .run();
    await processWishlistNotifications(
      fixture.env,
      Date.parse("2026-10-26T10:02:00.000Z")
    );
    expect(await readNotifications(fixture.db, "owner")).toEqual([]);
  });
});

function fixtureForTest() {
  return fixture();
}

describe("Web Push", () => {
  it("rejects arbitrary URLs, private hosts and redirected endpoint tricks", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/test")).toBe(
      true
    );
    expect(isPushEndpoint("https://web.push.apple.com/test")).toBe(true);
    for (const endpoint of [
      "http://fcm.googleapis.com/test",
      "https://127.0.0.1/test",
      "https://fcm.googleapis.com.attacker.test/test",
      "https://user@fcm.googleapis.com/test",
      "https://fcm.googleapis.com:123/test",
    ])
      expect(isPushEndpoint(endpoint)).toBe(false);
  });
  it("encrypts subscriptions and payloads, delivers once, and removes expired subscriptions", async () => {
    const fixture = fixtureForTest();
    const vapid = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const key = await crypto.subtle.exportKey("jwk", vapid.privateKey);
    const bytes = new Uint8Array(
      await crypto.subtle.exportKey("raw", vapid.publicKey)
    );
    const base64 = (value: Uint8Array) =>
      btoa(String.fromCharCode(...value))
        .replaceAll("=", "")
        .replaceAll("+", "-")
        .replaceAll("/", "_");
    fixture.env.VAPID_PUBLIC_KEY = base64(bytes);
    fixture.env.VAPID_PRIVATE_KEY = key.d!;
    fixture.env.VAPID_SUBJECT = "mailto:push@example.test";
    const client = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"]
    );
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test",
      keys: {
        p256dh: base64(
          new Uint8Array(await crypto.subtle.exportKey("raw", client.publicKey))
        ),
        auth: base64(crypto.getRandomValues(new Uint8Array(16))),
      },
    };
    expect(await savePushSubscription(fixture.env, "owner", subscription)).toBe(
      true
    );
    expect(
      String(
        fixture.sqlite
          .prepare("SELECT encrypted_subscription FROM push_subscriptions")
          .get()?.encrypted_subscription
      )
    ).not.toContain("googleapis");
    fixture.item();
    fixture.scan();
    await notifyWishlistScan(fixture.db, "owner", "scan");
    let calls = 0;
    const sender: typeof fetch = async (endpoint, init) => {
      calls++;
      expect(endpoint).toBe(subscription.endpoint);
      expect(init?.redirect).toBe("error");
      expect(JSON.stringify(init?.body)).not.toContain("پنیر");
      return new Response(null, { status: 201 });
    };
    await drainPushDeliveries(fixture.env, Date.now(), sender, {
      userId: "other",
      scanId: "scan",
    });
    await drainPushDeliveries(fixture.env, Date.now(), sender, {
      userId: "owner",
      scanId: "other-scan",
    });
    expect(calls).toBe(0);
    await drainPushDeliveries(fixture.env, Date.now(), sender, {
      userId: "owner",
      scanId: "scan",
    });
    expect(calls).toBe(1);
    await drainPushDeliveries(fixture.env, Date.now(), sender);
    expect(calls).toBe(1);
    fixture.scan("cheaper", 30000);
    await notifyWishlistScan(fixture.db, "owner", "cheaper");
    await drainPushDeliveries(
      fixture.env,
      Date.now(),
      async () => new Response(null, { status: 410 })
    );
    expect(
      fixture.sqlite
        .prepare("SELECT COUNT(*) count FROM push_subscriptions")
        .get()?.count
    ).toBe(0);
  });
});
