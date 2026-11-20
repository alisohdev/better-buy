import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
export const Route = createFileRoute("/settings")({ component: RouteAdapter });
function RouteAdapter() {
  useEffect(() => {
    window.location.replace("/?page=settings" + window.location.search);
  }, []);
  return null;
}
