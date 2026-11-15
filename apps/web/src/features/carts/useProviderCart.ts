"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cartResponseSchema,
  type CartResponse,
  type CartSource,
} from "@better-buy/shared";
import { api } from "../../lib/api";
import { useVisitor } from "../guest/VisitorProvider";

export type CartProvider = CartSource;

export const cartQueryKey = (
  source: CartProvider,
  locationId: string,
  scanId: string | null,
  coordinateRevision: number
) => ["cart", source, locationId, scanId, coordinateRevision] as const;

export function useProviderCart({
  source,
  locationId,
  scanId,
  coordinateRevision,
  enabled = true,
}: {
  source: CartProvider;
  locationId: string;
  scanId: string | null;
  coordinateRevision: number;
  enabled?: boolean;
}) {
  const visitor = useVisitor();
  const client = useQueryClient();
  const queryKey = cartQueryKey(source, locationId, scanId, coordinateRevision);
  const cart = useQuery({
    queryKey,
    enabled: !visitor.isGuest && enabled && !!locationId,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ locationId });
      return api<CartResponse>(
        `/api/carts/${source}?${params}`,
        { signal },
        cartResponseSchema.parse
      );
    },
  });

  const write = useMutation({
    mutationFn: async ({
      source: mutationSource,
      scanId: mutationScanId,
      key,
      quantity,
      remove,
      add,
    }: {
      source: CartProvider;
      scanId: string | null;
      key: string;
      quantity?: number;
      remove?: boolean;
      add?: boolean;
    }) => {
      const path = `/api/carts/${mutationSource}/items/${encodeURIComponent(key)}`;
      if (remove) return api<void>(path, { method: "DELETE" });
      return api<void>(path, {
        method: "PUT",
        body: JSON.stringify({
          ...(add && mutationScanId ? { scanId: mutationScanId } : {}),
          quantity: quantity ?? 1,
        }),
      });
    },
    onSettled: async (_data, _error, variables) => {
      await client.invalidateQueries({ queryKey: ["cart", variables.source] });
    },
  });

  const byKey = new Map(
    (cart.data?.lines ?? []).map((line) => [line.key, line])
  );
  return {
    cart,
    byKey,
    add: (key: string) => {
      if (visitor.requireAccount("نگهداری سبد خرید"))
        write.mutate({ source, scanId, key, add: true, quantity: 1 });
    },
    setQuantity: (key: string, quantity: number, onSettled?: () => void) => {
      if (visitor.requireAccount("نگهداری سبد خرید"))
        write.mutate(
          { source, scanId: null, key, quantity },
          { onSettled: () => onSettled?.() }
        );
    },
    remove: (key: string, onSettled?: () => void) => {
      if (visitor.requireAccount("نگهداری سبد خرید"))
        write.mutate(
          { source, scanId: null, key, remove: true },
          { onSettled: () => onSettled?.() }
        );
    },
    writingKey: write.variables?.source === source ? write.variables.key : null,
    writePending: write.variables?.source === source && write.isPending,
    writeError: write.variables?.source === source ? write.error : null,
    clearWriteError: write.reset,
  };
}
