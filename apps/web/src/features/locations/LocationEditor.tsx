"use client";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { LocationRecord } from "@better-buy/shared";
import { isWithinTehranBoundary } from "@better-buy/shared";
import { useLocationSearch } from "./useLocationSearch";
import { useLocationMutations } from "./useLocationMutations";
import { useLocationAddress } from "./useLocationAddress";
import "./location-editor.css";
const LocationMap = dynamic(() => import("../../app/LocationMap"), {
  ssr: false,
  loading: () => <div className="map-loading">در حال آماده‌سازی نقشه…</div>,
});
export type LocationStage = "map" | "details";

export function LocationEditor({
  location,
  onSaved,
  stage,
  onStageChange,
}: {
  location: LocationRecord | null;
  onSaved: (location?: LocationRecord) => void;
  stage: LocationStage;
  onStageChange: (stage: LocationStage) => void;
}) {
  const [name, setName] = useState(location?.name ?? "");
  const [latitude, setLatitude] = useState(location?.latitude ?? 35.7);
  const [longitude, setLongitude] = useState(location?.longitude ?? 51.4);
  const [isDefault, setDefault] = useState(location?.isDefault ?? false);
  const [selectedAddress, setSelectedAddress] = useState("");
  const resolvedAddress = useLocationAddress(
    latitude,
    longitude,
    stage === "details"
  );
  const [resultsOpen, setResultsOpen] = useState(true);
  const [geoState, setGeoState] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (stage === "details") nameRef.current?.focus({ preventScroll: true });
  }, [stage]);
  const { error, pending, save } = useLocationMutations(location?.id, onSaved);
  const {
    searchQuery,
    setSearchQuery,
    searchResults,
    searchState,
    searchError,
  } = useLocationSearch();
  const valid = isWithinTehranBoundary(latitude, longitude);
  const pick = ({ lat, lng }: { lat: number; lng: number }) => {
    setLatitude(lat);
    setLongitude(lng);
    setSelectedAddress("");
    setResultsOpen(false);
  };
  const locate = () => {
    if (!navigator.geolocation) {
      setGeoState(
        "مرورگر شما موقعیت‌یابی را پشتیبانی نمی‌کند؛ روی نقشه انتخاب کنید."
      );
      return;
    }
    setGeoState("در حال یافتن موقعیت…");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (!mounted.current) return;
        if (!isWithinTehranBoundary(coords.latitude, coords.longitude)) {
          setGeoState(
            "موقعیت شما خارج از تهران است؛ یک نقطه در تهران انتخاب کنید."
          );
          return;
        }
        pick({ lat: coords.latitude, lng: coords.longitude });
        setGeoState("");
      },
      () => {
        if (mounted.current)
          setGeoState(
            "موقعیت‌یابی انجام نشد؛ دسترسی مرورگر را بررسی کنید یا روی نقشه انتخاب کنید."
          );
      },
      { timeout: 10000, maximumAge: 60000 }
    );
  };
  return (
    <form
      className={`location-editor location-stage-${stage}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (stage === "map") {
          if (valid) onStageChange("details");
        } else if (valid && name.trim())
          save({ name: name.trim(), latitude, longitude, isDefault });
      }}
    >
      {stage === "map" ? (
        <>
          <div className="location-map-workspace">
            <LocationMap
              latitude={latitude}
              longitude={longitude}
              onChange={pick}
              centerOnMove
            />
            <div className="location-map-search" role="search">
              <div className="location-map-search-bar">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle
                    cx="10.5"
                    cy="10.5"
                    r="6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                  <path
                    d="m16 16 4 4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  />
                </svg>
                <Input
                  id="location-address-search"
                  aria-label="جست‌وجوی نشانی در تهران"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setResultsOpen(true);
                  }}
                  onFocus={() => setResultsOpen(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.preventDefault();
                    if (event.key === "Escape" && resultsOpen) {
                      event.preventDefault();
                      event.stopPropagation();
                      setResultsOpen(false);
                    }
                  }}
                  placeholder="جست‌وجوی محله، خیابان و…"
                  inputMode="search"
                  autoComplete="off"
                />
                <span className="location-city">تهران</span>
              </div>
              {resultsOpen && searchQuery.trim().length > 0 && (
                <div className="location-map-search-results">
                  <p role="status" className="location-search-feedback">
                    {searchQuery.trim().length < 3
                      ? "حداقل ۳ حرف بنویسید."
                      : searchState === "loading"
                        ? "در حال جست‌وجو…"
                        : searchState === "empty"
                          ? "نتیجه‌ای پیدا نشد؛ نام محله یا خیابان دیگری را امتحان کنید."
                          : searchState === "error"
                            ? searchError
                            : "نشانی موردنظر را انتخاب کنید."}
                  </p>
                  {searchState === "results" && (
                    <div
                      className="location-search-results"
                      aria-label="نتایج جست‌وجوی نشانی"
                    >
                      {searchResults.map((result) => (
                        <Button
                          className="location-result"
                          variant="ghost"
                          type="button"
                          key={`${result.latitude}:${result.longitude}`}
                          aria-label={result.displayName}
                          onClick={() => {
                            setLatitude(result.latitude);
                            setLongitude(result.longitude);
                            setSelectedAddress(result.displayName);
                            setResultsOpen(false);
                          }}
                        >
                          <span className="location-result-copy">
                            <strong>
                              {result.displayName.split(/[,،]/)[0]}
                            </strong>
                            <span>
                              {result.displayName
                                .split(/[,،]/)
                                .slice(1)
                                .join("، ")}
                            </span>
                          </span>
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <p className="location-pin-tip">
              برای انتخاب محل، نقشه را جابه‌جا کنید.
            </p>
            <Button
              type="button"
              variant="outline"
              className="location-geolocate"
              onClick={locate}
              disabled={geoState === "در حال یافتن موقعیت…"}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle
                  cx="12"
                  cy="12"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <circle cx="12" cy="12" r="2" fill="currentColor" />
                <path
                  d="M12 2v3m0 14v3M2 12h3m14 0h3"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
              </svg>
              موقعیت من
            </Button>
          </div>
          {geoState && (
            <p role="status" className="location-search-feedback">
              {geoState}
            </p>
          )}
          {!valid && (
            <p role="status" className="form-error">
              یک نقطه در محدوده تهران انتخاب کنید.
            </p>
          )}
          <div className="location-flow-footer">
            <Button type="submit" disabled={!valid}>
              تأیید موقعیت
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="location-preview">
            <div className="location-preview-pin" aria-hidden="true">
              <svg viewBox="0 0 24 32">
                <path
                  d="M12 30S2 18 2 11a10 10 0 0 1 20 0c0 7-10 19-10 19Z"
                  fill="var(--ring)"
                  stroke="var(--card)"
                  strokeWidth="2"
                />
                <circle cx="12" cy="11" r="3" fill="var(--card)" />
              </svg>
            </div>
            <div inert aria-hidden="true">
              <LocationMap
                latitude={latitude}
                longitude={longitude}
                onChange={() => {}}
              />
            </div>
            <button
              type="button"
              className="location-preview-edit"
              aria-label="تغییر موقعیت روی نقشه"
              onClick={() => onStageChange("map")}
            >
              <span>تغییر موقعیت روی نقشه</span>
            </button>
          </div>
          <p className="location-selected-address">
            {resolvedAddress.address ||
              selectedAddress ||
              (resolvedAddress.loading
                ? "در حال دریافت نشانی…"
                : "نشانی در دسترس نیست")}
          </p>
          <Label className="location-name-field">
            نام مکان
            <Input
              ref={nameRef}
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="مثلاً خانه یا محل کار"
            />
          </Label>
          <div className="location-name-shortcuts">
            {["خانه", "محل کار"].map((label) => (
              <Button
                variant="outline"
                type="button"
                key={label}
                aria-pressed={name === label}
                onClick={() => setName(label)}
              >
                {label}
              </Button>
            ))}
          </div>
          <div className="location-current-choice">
            <Checkbox
              id="default-location"
              checked={isDefault}
              aria-labelledby="current-location-label"
              aria-describedby="current-location-help"
              onCheckedChange={(checked) => setDefault(checked === true)}
            />
            <Label htmlFor="default-location">
              <strong id="current-location-label">موقعیت کنونی من</strong>
              <span id="current-location-help">
                پیشنهادها و اسکن‌های بعدی را برای این موقعیت نشان بده.
              </span>
            </Label>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="location-flow-footer">
            <Button type="submit" disabled={pending || !valid || !name.trim()}>
              {pending ? "در حال ذخیره…" : "ذخیره مکان"}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
