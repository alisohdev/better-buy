import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { parseNotifications, parseWishlist } from "./contracts";

export function useWishlistQuery() {
  return useQuery({
    queryKey: ["wishlist"],
    queryFn: ({ signal }) => api("/api/wishlist", { signal }, parseWishlist),
  });
}
export function useWishlist() {
  const client = useQueryClient();
  const query = useWishlistQuery();
  const mutation = useMutation({
    mutationFn: (
      action:
        | { kind: "add"; phrase: string; minDiscount: number }
        | { kind: "discount"; id: string; minDiscount: number }
        | { kind: "delete"; id: string }
        | { kind: "location"; locationId: string | null }
    ) => {
      if (action.kind === "add")
        return api("/api/wishlist", {
          method: "POST",
          body: JSON.stringify({
            phrase: action.phrase,
            minDiscount: action.minDiscount,
          }),
        });
      if (action.kind === "discount")
        return api("/api/wishlist/" + encodeURIComponent(action.id), {
          method: "PATCH",
          body: JSON.stringify({ minDiscount: action.minDiscount }),
        });
      if (action.kind === "delete")
        return api("/api/wishlist/" + encodeURIComponent(action.id), {
          method: "DELETE",
        });
      return api("/api/wishlist/location", {
        method: "PUT",
        body: JSON.stringify({ locationId: action.locationId }),
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["wishlist"] }),
  });
  return { query, mutation };
}
export function useInbox() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["notifications"],
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) =>
      api("/api/notifications", { signal }, parseNotifications),
  });
  const read = useMutation({
    mutationFn: (id: string) =>
      api("/api/notifications/" + encodeURIComponent(id) + "/read", {
        method: "POST",
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["notifications"] }),
  });
  return { query, read };
}
