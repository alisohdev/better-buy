"use client";

import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

function Select({
  dir = "rtl",
  ...props
}: ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" dir={dir} {...props} />;
}

function SelectValue(props: ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "inline-flex h-11 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground [&>span]:line-clamp-1",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <svg
          className="size-4 shrink-0 opacity-60"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="m5 7.5 5 5 5-5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  position = "popper",
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        position={position}
        className={cn(
          "relative z-50 max-h-72 min-w-32 overflow-hidden rounded-md border border-border bg-card p-1 text-foreground shadow-md",
          className
        )}
        {...props}
      >
        <SelectPrimitive.Viewport className="p-0.5">
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-11 w-full cursor-default items-center rounded-sm py-1.5 pe-8 ps-2 text-sm outline-none select-none focus:bg-muted focus:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute end-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <svg
            className="size-4"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m4 10 4 4 8-8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectValue, SelectTrigger, SelectContent, SelectItem };
