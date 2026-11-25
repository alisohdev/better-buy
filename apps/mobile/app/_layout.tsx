import { Stack } from "expo-router";
import { DiagnosticsProvider } from "../src/diagnostics";

export default function Layout() {
  return (
    <DiagnosticsProvider>
      <Stack screenOptions={{ title: "Better Buy · Engine Lab" }} />
    </DiagnosticsProvider>
  );
}
