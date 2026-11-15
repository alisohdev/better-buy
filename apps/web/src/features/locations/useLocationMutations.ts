import { useMutation } from "@tanstack/react-query";
import {
  locationRecordSchema,
  type LocationInput,
  type LocationRecord,
} from "@better-buy/shared";
import { api } from "../../lib/api";
import { useVisitor } from "../guest/VisitorProvider";
import { rememberGuestLocation, forgetGuestLocation } from "../guest/storage";
export function useLocationMutations(
  locationId: string | undefined,
  onSaved: (location?: LocationRecord) => void
) {
  const visitor = useVisitor();
  const saveMutation = useMutation({
    mutationFn: (input: LocationInput) =>
      api(
        "/api/locations" + (locationId ? "/" + locationId : ""),
        {
          method: locationId ? "PATCH" : "POST",
          body: JSON.stringify(input),
        },
        locationRecordSchema.parse
      ),
  });
  const removeMutation = useMutation({
    mutationFn: () => api("/api/locations/" + locationId, { method: "DELETE" }),
  });
  const save = (input: LocationInput) => {
    if (!saveMutation.isPending)
      saveMutation.mutate(input, {
        onSuccess: (saved) => {
          if (visitor.isGuest) {
            const persisted = rememberGuestLocation(saved);
            visitor.notify(
              persisted
                ? "موقعیت در همین مرورگر نگهداری شد و پس از ورود به حساب افزوده می‌شود."
                : "موقعیت فعلاً قابل استفاده است، اما مرورگر اجازه نگهداری آن را نداد. برای ذخیره در حساب وارد شوید."
            );
          }
          onSaved(saved);
        },
      });
  };
  const remove = (onFailure: () => void) => {
    if (locationId && !removeMutation.isPending)
      removeMutation.mutate(undefined, {
        onSuccess: () => {
          if (visitor.isGuest && !forgetGuestLocation(locationId))
            visitor.notify(
              "موقعیت حذف شد، اما پاک‌سازی نسخه مرورگر انجام نشد. تنظیمات ذخیره‌سازی مرورگر را بررسی کنید."
            );
          onSaved();
        },
        onError: onFailure,
      });
  };
  return {
    error: saveMutation.error?.message ?? removeMutation.error?.message ?? "",
    pending: saveMutation.isPending || removeMutation.isPending,
    save,
    remove,
  };
}
