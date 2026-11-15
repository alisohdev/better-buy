"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import {
  locationRecordSchema,
  locationsReadSchema,
  type LocationRecord,
} from "@better-buy/shared";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import {
  readGuestLocations,
  saveGuestLocations,
  forgetGuestLocation,
} from "./storage";
import { useVisitor } from "./VisitorProvider";

let starting: Promise<{ id: string; storageAvailable: boolean }> | null = null;

async function startGuest(): Promise<{
  id: string;
  storageAvailable: boolean;
}> {
  const session = await api<{ id: string }>("/api/guest/session", {
    method: "POST",
    body: "{}",
  });
  if (!session.id.startsWith("guest:"))
    throw new Error("وضعیت ورود تغییر کرده است؛ صفحه را تازه‌سازی کنید.");
  const headers = { "X-Better-Buy-Guest": session.id };
  let locations = await api(
    "/api/locations",
    { headers },
    locationsReadSchema.parse
  );
  for (const saved of readGuestLocations()) {
    if (
      locations.some(
        (item) =>
          item.latitude === saved.latitude && item.longitude === saved.longitude
      )
    )
      continue;
    const restored = await api(
      "/api/locations",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: saved.name,
          latitude: saved.latitude,
          longitude: saved.longitude,
          isDefault: locations.length === 0,
        }),
      },
      locationRecordSchema.parse
    );
    locations = [...locations, restored];
  }
  return { id: session.id, storageAvailable: saveGuestLocations(locations) };
}

export function GuestWorkspace({ children }: { children: ReactNode }) {
  const visitor = useVisitor();
  const bootstrap = useQuery({
    queryKey: ["guest-session"],
    retry: false,
    staleTime: Infinity,
    queryFn: () => {
      if (!starting)
        starting = startGuest().finally(() => {
          starting = null;
        });
      return starting;
    },
  });
  useEffect(() => {
    if (bootstrap.isSuccess && !bootstrap.data.storageAvailable)
      visitor.notify(
        "مرورگر اجازه نگهداری موقعیت را نمی‌دهد. می‌توانید اسکن کنید، اما برای نگهداری موقعیت وارد حساب شوید."
      );
  }, [bootstrap.isSuccess, bootstrap.data?.storageAvailable]);
  if (bootstrap.isPending)
    return (
      <main className="auth-loading" role="status">
        در حال آماده‌سازی حالت مهمان…
      </main>
    );
  if (bootstrap.isError)
    return (
      <main className="guest-recovery" role="alert">
        <h1>حالت مهمان آماده نشد</h1>
        <p>{bootstrap.error.message}</p>
        <Button onClick={() => void bootstrap.refetch()}>تلاش دوباره</Button>
      </main>
    );
  return children;
}

export function GuestLocationImport({ userId }: { userId: string }) {
  const client = useQueryClient();
  const visitor = useVisitor();
  const query = useQuery({
    queryKey: ["guest-location-import", userId],
    retry: false,
    staleTime: Infinity,
    queryFn: async () => {
      let imported = 0;
      try {
        for (const location of readGuestLocations().sort(
          (first, second) => Number(second.isDefault) - Number(first.isDefault)
        )) {
          await api<LocationRecord>(
            "/api/locations/import",
            {
              method: "POST",
              body: JSON.stringify({
                guestId: location.id,
                userId,
                name: location.name,
                latitude: location.latitude,
                longitude: location.longitude,
                isDefault: location.isDefault,
              }),
            },
            locationRecordSchema.parse
          );
          if (!forgetGuestLocation(location.id))
            throw new Error(
              "موقعیت به حساب افزوده شد؛ پاک‌سازی نسخه مرورگر انجام نشد. دوباره تلاش کنید."
            );
          imported++;
        }
      } finally {
        await client.invalidateQueries({ queryKey: ["locations"] });
      }
      return imported;
    },
  });
  useEffect(() => {
    if (query.isSuccess && query.data > 0)
      visitor.notify("موقعیت مهمان به حساب شما افزوده شد.");
  }, [query.isSuccess, query.data]);
  if (query.isError)
    return (
      <section className="guest-import-notice" role="alert">
        <p>
          موقعیت مرورگر هنوز به حساب منتقل نشده است و حذف نشده است.{" "}
          {query.error.message}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          تلاش دوباره
        </Button>
      </section>
    );
  return null;
}
