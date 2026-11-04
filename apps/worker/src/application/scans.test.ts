import { Context, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeScan,
  prepareScan,
  ProviderAccess,
  ProviderCollection,
  ScanPersistence,
  type Collection,
  type ScanJob,
} from "./scans";
import { CollectorError, PersistenceError } from "../domain/failures";

const job: ScanJob = {
  id: "scan-1",
  source: "snappmarket",
  threshold: 40,
  mode: "partial",
  locationId: "home",
  location: {
    id: "home",
    name: "خانه",
    latitude: 35.7,
    longitude: 51.4,
    isDefault: true,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  access: null,
};
const result: Collection = { vendorCount: 1, productCount: 1, deals: [] };

function services() {
  const events: string[] = [];
  const fail = vi.fn((id: string, code: string, message: string) =>
    Effect.sync(() => {
      events.push(`failed:${code}`);
    })
  );
  const succeed = vi.fn(() =>
    Effect.sync(() => {
      events.push("succeeded");
    })
  );
  const persistence = ScanPersistence.of({
    location: () => Effect.succeed(job.location),
    active: () => Effect.succeed(null),
    reserve: () => Effect.succeed(job.id),
    running: () =>
      Effect.sync(() => {
        events.push("running");
      }),
    progress: () =>
      Effect.sleep(100).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push("progress");
          })
        )
      ),
    succeed,
    fail,
  });
  const establish = vi.fn(() => Effect.succeed(null));
  const collection = ProviderCollection.of({
    collect: (_job, progress) =>
      Effect.gen(function* () {
        yield* progress(result);
        events.push("collected");
        return result;
      }),
  });
  const context = Context.make(ScanPersistence, persistence).pipe(
    Context.add(ProviderAccess, { establish }),
    Context.add(ProviderCollection, collection)
  );
  return { events, fail, succeed, persistence, collection, context, establish };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("scan ownership and failure boundary", () => {
  it.each(["okala", "snappmarket"] as const)(
    "uses one effective threshold for %s reservation and execution",
    async (source) => {
      const fixture = services();
      const reserve = vi.fn(() => Effect.succeed(job.id));
      const collect = vi.fn((prepared: ScanJob) => Effect.succeed(result));
      const context = fixture.context.pipe(
        Context.add(ScanPersistence, {
          ...fixture.persistence,
          reserve,
          progress: () => Effect.void,
        }),
        Context.add(ProviderCollection, { collect })
      );
      const prepared = await Effect.runPromise(
        prepareScan({ ...job, source, threshold: 20 }).pipe(
          Effect.provide(context)
        )
      );
      expect(prepared.threshold).toBe(source === "okala" ? 30 : 20);
      expect(reserve).toHaveBeenCalledWith(
        expect.objectContaining({ source, threshold: prepared.threshold }),
        job.location
      );
      await Effect.runPromise(
        executeScan(prepared).pipe(Effect.provide(context))
      );
      expect(collect).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: prepared.threshold }),
        expect.any(Function)
      );
    }
  );
  it("awaits progress before persistence and terminal success", async () => {
    vi.useFakeTimers();
    const fixture = services();
    const running = Effect.runPromise(
      executeScan(job).pipe(Effect.provide(fixture.context))
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(fixture.events).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(fixture.events).toEqual([
      "running",
      "progress",
      "collected",
      "succeeded",
    ]);
    expect(fixture.fail).not.toHaveBeenCalled();
  });
  it.each(["running", "progress", "succeed"] as const)(
    "records a persistence failure in %s without claiming success",
    async (operation) => {
      const fixture = services();
      const persistence = {
        ...fixture.persistence,
        progress: () => Effect.void,
        [operation]: () => Effect.fail(new PersistenceError(operation)),
      };
      await Effect.runPromise(
        executeScan(job).pipe(
          Effect.provide(
            fixture.context.pipe(Context.add(ScanPersistence, persistence))
          )
        )
      );
      expect(fixture.events.at(-1)).toBe("failed:PERSISTENCE_ERROR");
      if (operation !== "succeed")
        expect(fixture.succeed).not.toHaveBeenCalled();
    }
  );
  it("records expected collection failures without a persistence attempt", async () => {
    const fixture = services();
    const context = fixture.context.pipe(
      Context.add(ProviderCollection, {
        collect: () =>
          Effect.fail(new CollectorError("INCOMPLETE_PAGINATION", "ناقص")),
      })
    );
    await Effect.runPromise(executeScan(job).pipe(Effect.provide(context)));
    expect(fixture.fail).toHaveBeenCalledWith(
      job.id,
      "INCOMPLETE_PAGINATION",
      "ناقص"
    );
    expect(fixture.succeed).not.toHaveBeenCalled();
  });
  it("keeps unexpected defects distinct and never exposes their message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fixture = services();
    const context = fixture.context.pipe(
      Context.add(ProviderCollection, {
        collect: () => Effect.die(new Error("personal-token-fixture")),
      })
    );
    await Effect.runPromise(executeScan(job).pipe(Effect.provide(context)));
    expect(fixture.fail).toHaveBeenCalledWith(
      job.id,
      "UNKNOWN_ERROR",
      expect.not.stringContaining("personal-token")
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "personal-token"
    );
  });
  it("allows collection to finish beyond the former overall time budget", async () => {
    vi.useFakeTimers();
    const fixture = services();
    const context = fixture.context.pipe(
      Context.add(ProviderCollection, {
        collect: () => Effect.sleep(25_000).pipe(Effect.map(() => result)),
      })
    );
    const running = Effect.runPromise(
      executeScan(job).pipe(Effect.provide(context))
    );
    await vi.advanceTimersByTimeAsync(25_000);
    await running;
    expect(fixture.fail).not.toHaveBeenCalled();
    expect(fixture.succeed).toHaveBeenCalledWith(job.id, result);
  });
  it("leaves finalization failures visible to the execution boundary", async () => {
    const fixture = services();
    const context = fixture.context.pipe(
      Context.add(ProviderCollection, {
        collect: () => Effect.fail(new CollectorError("AUTH_REJECTED", "رد")),
      }),
      Context.add(ScanPersistence, {
        ...fixture.persistence,
        fail: () => Effect.fail(new PersistenceError("fail")),
      })
    );
    await expect(
      Effect.runPromise(executeScan(job).pipe(Effect.provide(context)))
    ).rejects.toMatchObject({ operation: "fail" });
  });
  it("checks domain eligibility before establishing access or reserving", async () => {
    const fixture = services();
    const context = fixture.context.pipe(
      Context.add(ScanPersistence, {
        ...fixture.persistence,
        location: () => Effect.succeed({ ...job.location, latitude: 0 }),
      })
    );
    await expect(
      Effect.runPromise(prepareScan(job).pipe(Effect.provide(context)))
    ).rejects.toMatchObject({ code: "OUTSIDE_TEHRAN" });
    expect(fixture.establish).not.toHaveBeenCalled();
  });
});
