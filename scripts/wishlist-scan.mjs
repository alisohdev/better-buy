import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";

const args = process.argv.slice(2);
const usage =
  "Usage: npm run wishlist:scan -- [--user-id ID] [--source snappmarket|okala] [--market-party-only] [--url http://127.0.0.1:8787] [--timeout-ms MS]";
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
  process.exit(0);
}
const options = {};
for (let i = 0; i < args.length;) {
  const name = args[i];
  if (name === "--market-party-only") {
    options[name] = true;
    i++;
    continue;
  }
  if (
    !["--user-id", "--source", "--url", "--timeout-ms"].includes(name) ||
    !args[i + 1]
  ) {
    console.error(usage);
    process.exit(1);
  }
  options[name] = args[i + 1];
  i += 2;
}
const url = new URL(options["--url"] ?? "http://127.0.0.1:8787");
if (
  url.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
) {
  throw new Error("The Worker URL must be a local HTTP origin.");
}
const source = options["--source"];
if (source && !["snappmarket", "okala"].includes(source))
  throw new Error("Source must be snappmarket or okala.");
const timeout = Number(options["--timeout-ms"] ?? 0);
if (!Number.isSafeInteger(timeout) || timeout < 0)
  throw new Error(
    "Timeout must be a nonnegative number of milliseconds (0 waits indefinitely)."
  );
let cookie = "";
const varsPath = new URL("../apps/worker/.dev.vars", import.meta.url);
const localVars = existsSync(varsPath)
  ? parseEnv(readFileSync(varsPath, "utf8"))
  : {};
const secret = localVars.BETTER_AUTH_SECRET ?? process.env.BETTER_AUTH_SECRET;
if (!secret)
  throw new Error("BETTER_AUTH_SECRET is missing from apps/worker/.dev.vars.");
async function request(path, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Date.now());
  const devHeaders = path.startsWith("/api/dev/wishlist/")
    ? {
        "x-better-buy-dev-time": timestamp,
        "x-better-buy-dev-signature": createHmac("sha256", secret)
          .update(
            `better-buy-dev-wishlist-v1\n${timestamp}\nPOST\n${path}\n${payload}`
          )
          .digest("hex"),
      }
    : {};
  const response = await fetch(new URL(path, url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      "x-better-buy-dev": "wishlist",
      ...devHeaders,
    },
    ...(body === undefined ? {} : { body: payload }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => {
    throw new Error(
      `Could not reach the local Worker at ${url.origin}. Start npm run dev and check its API port. (${error.message})`
    );
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const data = await response.json().catch(() => ({}));
  if (data.error === "WISHLIST_OR_LOCATION_MISSING")
    throw new Error(
      "The selected user needs a wishlist phrase and a default wishlist location before running a scan."
    );
  if (response.status === 404 && path.startsWith("/api/dev/wishlist/"))
    throw new Error(
      "Development command unavailable. Restart npm run dev and check DEV_MODE=true and BETTER_AUTH_SECRET in apps/worker/.dev.vars."
    );
  if (!response.ok)
    throw new Error(
      `${path}: ${response.status} ${data.error ?? response.statusText}${data.message ? `: ${data.message}` : ""}`
    );
  return data;
}

async function main() {
  await request("/api/auth/test-login", {});
  if (!cookie)
    throw new Error("Local test login did not return a session cookie.");
  const session = await request("/api/auth/get-session");
  const userId = options["--user-id"] ?? session.user?.id;
  if (!userId)
    throw new Error(
      "No user ID provided and the local test session has no user."
    );
  console.log(`Testing wishlist for user ${userId}`);
  let failed = false;
  for (const provider of source ? [source] : ["snappmarket", "okala"]) {
    const marketPartyOnly =
      provider === "snappmarket" && Boolean(options["--market-party-only"]);
    if (marketPartyOnly)
      console.log(
        "snappmarket: store-campaign enrichment disabled for this development run."
      );
    const { data: scan } = await request("/api/dev/wishlist/start", {
      userId,
      source: provider,
      key: randomUUID(),
      marketPartyOnly,
    });
    console.log(`${provider}: started scan ${scan.scanId}`);
    const deadline = Date.now() + timeout;
    let lastStatus = "";
    for (;;) {
      const { data } = await request("/api/dev/wishlist/status", {
        userId,
        scanId: scan.scanId,
      });
      if (data.status !== lastStatus) {
        console.log(`${provider}: ${data.status}`);
        lastStatus = data.status;
      }
      if (data.status === "succeeded") {
        if (data.notification)
          console.log(JSON.stringify(data.notification, null, 2));
        else
          console.log(
            `${provider}: no new notification; no new or cheaper wishlist matches were found.`
          );
        console.log(`${provider}: browser push ${data.push}`);
        break;
      }
      if (["failed", "cancelled"].includes(data.status)) {
        console.error(
          `${provider}: scan ${data.status}${data.errorCode ? ` (${data.errorCode})` : ""}${data.errorMessage ? `: ${data.errorMessage}` : ""}`
        );
        failed = true;
        break;
      }
      if (timeout > 0 && Date.now() >= deadline)
        throw new Error(
          `${provider}: timed out waiting for scan ${scan.scanId}; the scan may still be running.`
        );
      await sleep(3_000);
    }
  }
  if (failed) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
