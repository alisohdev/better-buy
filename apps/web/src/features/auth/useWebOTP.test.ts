import { describe, it, expect } from "vitest";
import { normalizeDigits } from "./useWebOTP";
describe("OTP digits", () => {
  it("normalizes Persian and Arabic numerals without changing ASCII", () => {
    expect(normalizeDigits("۰۱۲۳۴۵۶۷۸۹ ٠١٢٣٤٥٦٧٨٩ 123")).toBe(
      "0123456789 0123456789 123"
    );
  });
});
