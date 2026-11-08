import { describe, expect, it } from "vitest";
import {
  cartAddItemSchema,
  cartLocationQuerySchema,
  cartSourceSchema,
  cartUpdateItemSchema,
} from "./cart";

describe("provider cart contracts", () => {
  it("supports only enabled cart providers", () => {
    expect(cartSourceSchema.safeParse("snappmarket").success).toBe(true);
    expect(cartSourceSchema.safeParse("okala").success).toBe(true);
    expect(cartSourceSchema.safeParse("digikalajet").success).toBe(true);
  });

  it("validates absolute quantity updates and bounded scan identities", () => {
    expect(
      cartAddItemSchema.safeParse({ scanId: "scan", quantity: 1 }).success
    ).toBe(true);
    expect(
      cartAddItemSchema.safeParse({ scanId: "scan", quantity: 99 }).success
    ).toBe(true);
    expect(
      cartAddItemSchema.safeParse({ scanId: "scan", quantity: 0 }).success
    ).toBe(false);
    expect(cartUpdateItemSchema.safeParse({ quantity: 100 }).success).toBe(
      false
    );
    expect(
      cartLocationQuerySchema.safeParse({ locationId: "home" }).success
    ).toBe(true);
  });
});
