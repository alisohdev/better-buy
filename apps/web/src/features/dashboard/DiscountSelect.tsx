"use client";

import { useState } from "react";
import { Popover } from "radix-ui";
import { InlineSlider } from "@/components/beui/components/motion/range-slider-inline";
import { faNumber } from "./format";

const percent = (value: number) => `${faNumber.format(value)}٪`;

type DiscountProps = {
  value: number;
  onChange: (value: number) => void;
};

export function DiscountFields({ value, onChange }: DiscountProps) {
  const [draft, setDraft] = useState<number>();
  return (
    <InlineSlider
      dir="rtl"
      label="حداقل تخفیف"
      value={draft ?? value}
      min={15}
      max={80}
      step={1}
      format={percent}
      className="rounded-[9px] bg-background"
      onValueChange={setDraft}
      onValueCommit={(next) => {
        setDraft(undefined);
        onChange(next);
      }}
      onPointerCancel={() => setDraft(undefined)}
    />
  );
}

export function DiscountSelect(props: DiscountProps) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="discount-select-trigger"
          aria-label="حداقل تخفیف نتیجه‌ها"
        >
          <span>{percent(props.value)} تخفیف و بیشتر</span>
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
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
          aria-label="فیلتر تخفیف"
        >
          <DiscountFields {...props} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
