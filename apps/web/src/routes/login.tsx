import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
export const Route = createFileRoute("/login")({ component: RouteAdapter });
function RouteAdapter() {
  useEffect(() => {
    window.location.replace("/?page=login" + window.location.search);
  }, []);
  return null;
}
