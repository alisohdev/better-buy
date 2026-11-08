import { displayToman } from "@better-buy/shared";
import type { DealSource } from "./types";
export const faNumber = new Intl.NumberFormat("fa-IR");
export const faDate = new Intl.DateTimeFormat("fa-IR", {
  dateStyle: "medium",
  timeStyle: "short",
});
export const sourceLabel = (source: DealSource) =>
  source === "digikalajet"
    ? "سوپرمارکت دیجی‌کالا"
    : source === "okala"
      ? "اکالا"
      : "اسنپ‌مارکت";
export const money = (
  amount: number,
  source: "snappmarket" | "digikalajet" | "okala"
) => `${faNumber.format(displayToman(amount, source))} تومان`;
