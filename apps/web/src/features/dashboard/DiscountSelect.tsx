"use client";

import { useEffect, useId, useState } from "react";
import { Popover } from "radix-ui";
import { faNumber } from "./format";

export function DiscountSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next =
      draft === ""
        ? value
        : Math.max(15, Math.min(80, Math.round(Number(draft))));
    setDraft(String(next));
    onChange(next);
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="discount-select-trigger"
          aria-label="حداقل تخفیف نتیجه‌ها"
        >
          <span>{faNumber.format(value)}٪ تخفیف و بیشتر</span>
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="discount-select-menu"
          sideOffset={6}
          align="end"
          dir="rtl"
          aria-label="انتخاب حداقل تخفیف"
        >
          <div className="discount-custom">
            <label htmlFor={inputId}>درصد دلخواه</label>
            <div className="discount-stepper" dir="ltr">
              <button
                type="button"
                aria-label="کاهش درصد تخفیف"
                disabled={value <= 15}
                onClick={() => {
                  const next = Math.max(15, value - 1);
                  setDraft(String(next));
                  onChange(next);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6 12h12" />
                </svg>
              </button>
              <input
                id={inputId}
                type="number"
                aria-label="درصد تخفیف دلخواه"
                min={15}
                max={80}
                step={1}
                dir="ltr"
                value={draft}
                onChange={(event) => {
                  const raw = event.target.value;
                  setDraft(raw);
                  const next = Number(raw);
                  if (
                    raw !== "" &&
                    Number.isInteger(next) &&
                    next >= 15 &&
                    next <= 80
                  )
                    onChange(next);
                }}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                  }
                }}
              />
              <span aria-hidden="true">٪</span>
              <button
                type="button"
                aria-label="افزایش درصد تخفیف"
                disabled={value >= 80}
                onClick={() => {
                  const next = Math.min(80, value + 1);
                  setDraft(String(next));
                  onChange(next);
                }}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24">
                  <path d="M6 12h12M12 6v12" />
                </svg>
              </button>
            </div>
          </div>
          <div
            className="discount-select-presets"
            role="group"
            aria-label="تخفیف‌های پیشنهادی"
          >
            {[15, 20, 30, 40, 50, 60, 80].map((percent) => (
              <Popover.Close asChild key={percent}>
                <button
                  type="button"
                  aria-pressed={value === percent}
                  onClick={() => {
                    setDraft(String(percent));
                    onChange(percent);
                  }}
                >
                  <span>{faNumber.format(percent)}٪</span>
                  <span className="discount-preset-check" aria-hidden="true">
                    {value === percent ? "✓" : ""}
                  </span>
                </button>
              </Popover.Close>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
