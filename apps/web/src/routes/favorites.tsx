import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
export const Route = createFileRoute("/favorites")({ component: RouteAdapter });
function RouteAdapter() {
  useEffect(() => {
    window.location.replace("/?page=favorites" + window.location.search);
  }, []);
  return null;
}
