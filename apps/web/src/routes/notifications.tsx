import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
export const Route = createFileRoute("/notifications")({
  component: RouteAdapter,
});
function RouteAdapter() {
  useEffect(() => {
    window.location.replace("/?page=notifications" + window.location.search);
  }, []);
  return null;
}
