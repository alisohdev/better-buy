import { faNumber } from "./format";

export function DiscountFilter({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <section
      className="compact-discount-filter"
      aria-label="فیلتر نتیجه‌ها بر اساس تخفیف"
    >
      <span className="discount-filter-caption">حداقل تخفیف</span>
      <div
        className="discount-presets"
        role="group"
        aria-label="تخفیف‌های پیشنهادی"
      >
        {[15, 30, 40, 50, 70].map((percent) => (
          <button
            key={percent}
            type="button"
            aria-pressed={value === percent}
            onClick={() => onChange(percent)}
          >
            {percent === 15 ? "همه" : `${faNumber.format(percent)}٪+`}
          </button>
        ))}
      </div>
      <label className="discount-exact">
        <span className="sr-only">حداقل تخفیف نتیجه‌ها</span>
        <select
          aria-label="حداقل تخفیف نتیجه‌ها"
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {Array.from({ length: 66 }, (_, i) => i + 15).map((percent) => (
            <option key={percent} value={percent}>
              {faNumber.format(percent)}٪ و بیشتر
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
