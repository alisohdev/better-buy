import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
export const Route = createFileRoute("/cart")({ component: RouteAdapter });
function RouteAdapter() {
  useEffect(() => {
    window.location.replace("/?page=cart" + window.location.search);
  }, []);
  return null;
}
