"use client";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useState } from "react";
import dynamic from "next/dynamic";
import { AlertDialog } from "radix-ui";
import type { LocationRecord } from "@better-buy/shared";
import { isWithinTehranBoundary } from "@better-buy/shared";
import { useLocationSearch } from "./useLocationSearch";
import { useLocationMutations } from "./useLocationMutations";
const LocationMap = dynamic(() => import("../../app/LocationMap"), {
  ssr: false,
  loading: () => <div className="map-loading">در حال آماده‌سازی نقشه…</div>,
});

export function LocationEditor({
  location,
  onSaved,
}: {
  location: LocationRecord | null;
  onSaved: (location?: LocationRecord) => void;
}) {
  const [name, setName] = useState(location?.name ?? "");
  const [latitude, setLatitude] = useState(location?.latitude ?? 35.7);
  const [longitude, setLongitude] = useState(location?.longitude ?? 51.4);
  const [isDefault, setDefault] = useState(location?.isDefault ?? false);
  const {
    error,
    pending,
    save: saveLocation,
    remove: removeLocation,
  } = useLocationMutations(location?.id, onSaved);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [mapOpen, setMapOpen] = useState(true);
  const {
    searchQuery,
    setSearchQuery,
    searchResults,
    searchState,
    searchError,
    searchAddress,
  } = useLocationSearch();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    void saveLocation({ name, latitude, longitude, isDefault });
  };
  const remove = () => removeLocation(() => setConfirmingRemoval(false));
  return (
    <>
      <form onSubmit={save}>
        <Label>
          نام مکان
          <Input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً خانه یا محل کار"
          />
        </Label>
        <div className="location-search" role="search">
          <Label htmlFor="location-address-search">
            جست‌وجوی نشانی در تهران
          </Label>
          <div className="location-search-control">
            <Input
              id="location-address-search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void searchAddress();
                }
              }}
              placeholder="مثلاً میدان ونک"
              inputMode="search"
            />
            <Button
              variant="outline"
              type="button"
              onClick={() => void searchAddress()}
              disabled={searchState === "loading"}
            >
              {searchState === "loading" ? "در حال جست‌وجو…" : "جست‌وجو"}
            </Button>
          </div>
          {searchState === "error" && (
            <p className="location-search-status is-error" role="alert">
              {searchError}
            </p>
          )}
          {searchState === "empty" && (
            <p className="location-search-status" role="status">
              نتیجه‌ای در محدوده تهران پیدا نشد؛ نام محله یا خیابان را امتحان
              کنید.
            </p>
          )}
          {searchState === "results" && (
            <div
              className="location-search-results"
              aria-label="نتایج جست‌وجوی نشانی"
            >
              {searchResults.map((result) => (
                <Button
                  variant="outline"
                  type="button"
                  aria-pressed={
                    latitude === result.latitude &&
                    longitude === result.longitude
                  }
                  key={`${result.latitude}:${result.longitude}:${result.displayName}`}
                  onClick={() => {
                    setLatitude(result.latitude);
                    setLongitude(result.longitude);
                    setMapOpen(true);
                  }}
                >
                  {result.displayName}
                </Button>
              ))}
            </div>
          )}
        </div>
        <details
          open={mapOpen}
          onToggle={(event) => setMapOpen(event.currentTarget.open)}
        >
          <summary>انتخاب موقعیت روی نقشه</summary>
          {mapOpen && (
            <LocationMap
              latitude={latitude}
              longitude={longitude}
              onChange={({ lat, lng }) => {
                setLatitude(lat);
                setLongitude(lng);
              }}
            />
          )}
        </details>
        <div className="check">
          <Checkbox
            id="default-location"
            checked={isDefault}
            onCheckedChange={(checked) => setDefault(checked === true)}
          />
          <Label htmlFor="default-location">مکان پیش‌فرض باشد</Label>
        </div>
        {!isWithinTehranBoundary(latitude, longitude) && (
          <p className="form-error" role="status">
            این موقعیت خارج از محدوده تهران است.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button
            variant="outline"
            disabled={pending || !isWithinTehranBoundary(latitude, longitude)}
          >
            {pending ? "در حال ذخیره…" : "ذخیره مکان"}
          </Button>
          {location && (
            <Button
              variant="destructive"
              type="button"
              disabled={pending}
              onClick={() => setConfirmingRemoval(true)}
            >
              حذف مکان و تاریخچه
            </Button>
          )}
        </div>
      </form>
      {location && (
        <AlertDialog.Root
          open={confirmingRemoval}
          onOpenChange={setConfirmingRemoval}
        >
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="sheet-backdrop" />
            <AlertDialog.Content className="panel delete-confirmation">
              <AlertDialog.Title>حذف «{location.name}»؟</AlertDialog.Title>
              <AlertDialog.Description>
                همه تاریخچه اسکن‌ها و پیشنهادهای این موقعیت برای همیشه حذف
                می‌شوند. این کار قابل بازگشت نیست.
              </AlertDialog.Description>
              <div>
                <AlertDialog.Cancel asChild>
                  <Button variant="outline" type="button" disabled={pending}>
                    انصراف
                  </Button>
                </AlertDialog.Cancel>
                <Button
                  variant="destructive"
                  type="button"
                  disabled={pending}
                  onClick={() => void remove()}
                >
                  حذف همیشگی
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
    </>
  );
}
