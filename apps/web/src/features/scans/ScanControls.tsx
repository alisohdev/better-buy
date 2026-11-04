import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CartSource, LocationRecord } from "@better-buy/shared";
import { AppIcon, ProviderMark } from "../dashboard/AppIcon";
import { faNumber, sourceLabel } from "../dashboard/format";

const providers: CartSource[] = ["snappmarket", "okala"];

export function ScanControls({
  locations,
  selected,
  selectedProviders,
  minDiscount,
  blocked,
  submitting,
  hasSnapshot,
  historical,
  onLocation,
  onToggleProvider,
  onMinDiscount,
  onStart,
  onLive,
}: {
  locations: LocationRecord[];
  selected: string;
  selectedProviders: CartSource[];
  minDiscount: number;
  blocked: boolean;
  submitting: boolean;
  hasSnapshot: boolean;
  historical: boolean;
  onLocation: (id: string) => void;
  onToggleProvider: (source: CartSource) => void;
  onMinDiscount: (value: number) => void;
  onStart: () => void;
  onLive: () => void;
}) {
  return (
    <section className="scan-controls" aria-label="تنظیم اسکن تخفیف‌ها">
      <Label className="feed-location scan-location-control">
        <span className="scan-control-label">
          <AppIcon name="location" />
          موقعیت تحویل
        </span>
        <Select value={selected || undefined} onValueChange={onLocation}>
          <SelectTrigger id="selected-location" aria-label="موقعیت تحویل">
            <SelectValue placeholder="یک موقعیت اضافه کنید" />
          </SelectTrigger>
          <SelectContent>
            {locations.map((location) => (
              <SelectItem key={location.id} value={location.id}>
                {location.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Label>

      <fieldset className="provider-checklist">
        <legend>انتخاب فروشگاه‌ها</legend>
        <div className="provider-card-grid">
          {providers.map((source) => {
            const checked = selectedProviders.includes(source);
            return (
              <label
                className="provider-option"
                key={source}
                data-checked={checked}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={checked && selectedProviders.length === 1}
                  onChange={() => onToggleProvider(source)}
                />
                <ProviderMark source={source} />
                <span className="provider-copy">
                  <strong>{sourceLabel(source)}</strong>
                </span>
                <span className="provider-checkmark" aria-hidden="true">
                  <AppIcon name="check" />
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="discount-filter scan-discount-filter">
        <div className="scan-discount-heading">
          <span>محدوده تخفیف</span>
          <output htmlFor="discount-filter">
            {faNumber.format(minDiscount)}٪
          </output>
        </div>
        <p>از {faNumber.format(minDiscount)}٪ به بالا</p>
        <input
          id="discount-filter"
          type="range"
          min={15}
          max={80}
          step={1}
          value={minDiscount}
          aria-valuetext={`${faNumber.format(minDiscount)} درصد و بیشتر`}
          onChange={(event) => onMinDiscount(Number(event.target.value))}
        />
        <span className="range-limits" aria-hidden="true">
          <span>۱۵٪</span>
          <span>۸۰٪</span>
        </span>
        <small className="scan-filter-hint">
          این فیلتر نتیجه‌ها را بدون اسکن دوباره به‌روز می‌کند.
        </small>
      </div>

      <div className="scan-setup-actions">
        <Button
          className="primary scan-button"
          disabled={blocked}
          onClick={onStart}
        >
          <AppIcon name="scan" />
          {submitting
            ? "در حال شروع…"
            : hasSnapshot
              ? "اسکن دوباره"
              : "شروع اسکن"}
        </Button>
        {historical && (
          <Button variant="outline" onClick={onLive}>
            بازگشت به تازه‌ترین پیشنهادها
          </Button>
        )}
      </div>
    </section>
  );
}
