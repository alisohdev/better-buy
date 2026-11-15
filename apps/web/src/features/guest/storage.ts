import {
  isWithinTehranBoundary,
  locationsReadSchema,
  type LocationRecord,
} from "@better-buy/shared";

export const guestLocationKey = "better-buy.guest-locations.v1";

export function readGuestLocations(): LocationRecord[] {
  try {
    const raw = localStorage.getItem(guestLocationKey);
    if (!raw || raw.length > 40000) return [];
    const parsed = locationsReadSchema.safeParse(JSON.parse(raw));
    if (
      !parsed.success ||
      parsed.data.length > 20 ||
      parsed.data.some(
        (item) => !isWithinTehranBoundary(item.latitude, item.longitude)
      )
    )
      return [];
    return parsed.data;
  } catch {
    return [];
  }
}

export function saveGuestLocations(locations: LocationRecord[]): boolean {
  try {
    localStorage.setItem(
      guestLocationKey,
      JSON.stringify(locations.slice(0, 20))
    );
    return true;
  } catch {
    return false;
  }
}

export function rememberGuestLocation(location: LocationRecord): boolean {
  const saved = readGuestLocations();
  return saveGuestLocations([
    location,
    ...saved.filter((item) => item.id !== location.id),
  ]);
}

export function forgetGuestLocation(id: string): boolean {
  return saveGuestLocations(
    readGuestLocations().filter((location) => location.id !== id)
  );
}
