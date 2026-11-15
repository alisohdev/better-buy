import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useVisitor } from "../guest/VisitorProvider";
import {
  parseAdminAccess,
  parseAdminOverview,
  parseAdminUser,
  parseAdminUsers,
} from "./contracts";

export function useAdminAccess() {
  const { isGuest } = useVisitor();
  return useQuery({
    enabled: !isGuest,
    queryKey: ["admin", "access"],
    queryFn: ({ signal }) =>
      api("/api/admin/access", { signal }, parseAdminAccess),
    retry: false,
  });
}

export function useAdminOverview() {
  return useQuery({
    queryKey: ["admin", "overview"],
    queryFn: ({ signal }) =>
      api("/api/admin/analytics", { signal }, parseAdminOverview),
  });
}

export function useAdminUsers(query: string, page: number) {
  return useQuery({
    queryKey: ["admin", "users", query, page],
    queryFn: ({ signal }) =>
      api(
        `/api/admin/users?${new URLSearchParams({ q: query, page: String(page) })}`,
        { signal },
        parseAdminUsers
      ),
  });
}

export function useAdminUser(userId: string | null) {
  return useQuery({
    queryKey: ["admin", "user", userId],
    enabled: userId !== null,
    queryFn: ({ signal }) =>
      api(
        `/api/admin/users/${encodeURIComponent(userId ?? "")}`,
        { signal },
        parseAdminUser
      ),
  });
}
