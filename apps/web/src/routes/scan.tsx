import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
export const Route = createFileRoute("/scan")({ component: RouteAdapter });
function RouteAdapter() {
  useEffect(() => {
    window.location.replace("/?page=scan" + window.location.search);
  }, []);
  return null;
}
