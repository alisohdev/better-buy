import { DiscountSelect } from "./DiscountSelect";
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
        {[15, 20, 30, 40, 50, 60, 80].map((percent) => (
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
      <DiscountSelect value={value} onChange={onChange} />
    </section>
  );
}
