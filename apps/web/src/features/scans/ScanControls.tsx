import { TutorialHint, useTutorial } from "../dashboard/Tutorial";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LocationRecord } from "@better-buy/shared";
import type { DealSource } from "../dashboard/types";
import { AppIcon, ProviderMark } from "../dashboard/AppIcon";
import { sourceLabel } from "../dashboard/format";

export const digikalaSupermarketEnabled =
  process.env.NEXT_PUBLIC_DIGIKALA_SUPERMARKET_ENABLED === "true";

export function ScanControls({
  locations,
  selected,
  selectedProviders,
  blocked,
  submitting,
  hasSnapshot,
  historical,
  onLocation,
  onToggleProvider,
  onStart,
  onLive,
}: {
  locations: LocationRecord[];
  selected: string;
  selectedProviders: DealSource[];
  blocked: boolean;
  submitting: boolean;
  hasSnapshot: boolean;
  historical: boolean;
  onLocation: (id: string) => void;
  onToggleProvider: (source: DealSource) => void;
  onStart: () => void;
  onLive: () => void;
}) {
  const tutorial = useTutorial();
  const providers: DealSource[] = digikalaSupermarketEnabled
    ? ["snappmarket", "okala", "digikalajet"]
    : ["snappmarket", "okala"];
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

      <TutorialHint at="scan" />
      <div className="scan-setup-actions">
        <Button
          data-tutorial-target={tutorial.step === "scan"}
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
