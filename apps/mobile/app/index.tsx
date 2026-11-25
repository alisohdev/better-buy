import { useDiagnostics } from "../src/diagnostics";
import { CODES, EVENTS, observability } from "../src/observability";
import { Button, ScrollView, Share, Text } from "react-native";

export default function Diagnostics() {
  const {
    appVersion,
    available,
    version,
    status,
    saved,
    code,
    setCode,
    ready,
    pending,
    act,
  } = useDiagnostics();
  const monitoring = observability.monitoring();
  const runtime = observability.runtime();
  const recent = observability.list().slice(-8);
  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 14 }}>
      <Text>
        App {appVersion} · Engine {version || "unavailable"} · OS{" "}
        {runtime.osVersion || "unknown"}
      </Text>
      <Text>
        {available
          ? monitoring.enabled
            ? `Fixture mode · remote monitoring ${monitoring.provider}`
            : "Fixture mode · remote monitoring off"
          : "Install a native development build."}
      </Text>
      <Text>Scan {status?.id || "none"}</Text>
      <Text>
        Scan: {status?.state ?? "—"} · {status?.progress ?? 0}/3
      </Text>
      <Text>
        {status?.durationMs ?? 0} ms · {status?.requests ?? 0} retailer requests
      </Text>
      <Button
        title="Run fixture scan"
        disabled={!ready || pending || status?.state === "running"}
        onPress={() =>
          void act(async (native) => {
            const result = await native.start();
            if (result === "OK") return;
            setCode(result);
            if (result === "BUSY") {
              observability.record({
                level: "WARN",
                event: EVENTS.lifecycle,
                code: CODES.BUSY,
                scanId: status?.id,
                provider: "fixture",
                stage: "fixture",
                message: "scan already running",
              });
              return;
            }
            observability.scanFailed({
              code:
                result === "ENGINE_INIT_FAILED"
                  ? CODES.ENGINE_INIT_FAILED
                  : CODES.NATIVE_BRIDGE_FAILED,
              provider: "fixture",
              stage: "fixture",
              message: "fixture start rejected",
            });
          })
        }
      />
      <Button
        title="Cancel scan"
        disabled={pending || status?.state !== "running"}
        onPress={() => void act((native) => native.cancel())}
      />
      <Button
        title="Trigger controlled error"
        disabled={!ready || pending}
        onPress={() =>
          void act(async (native) => {
            const result = await native.controlledError();
            setCode(result);
            if (result === "FIXTURE_ERROR")
              observability.controlledError({ scanId: status?.id });
          })
        }
      />
      <Button
        title="Export local diagnostics"
        disabled={!ready || pending}
        onPress={() =>
          void act(async (native) => {
            let engineLogs: unknown = [];
            try {
              engineLogs = JSON.parse(await native.logs());
            } catch {
              engineLogs = [];
            }
            try {
              await Share.share({
                message: JSON.stringify(
                  observability.exportDiagnostics(engineLogs),
                  null,
                  2
                ),
              });
            } catch {
              setCode(CODES.EXPORT_FAILED);
              observability.record({
                level: "ERROR",
                event: EVENTS.lifecycle,
                code: CODES.EXPORT_FAILED,
                message: "local export failed",
              });
            }
          })
        }
      />
      {code ? <Text accessibilityLiveRegion="polite">{code}</Text> : null}
      <Text>Last saved scan: {saved?.id ?? "none"}</Text>
      {saved?.offers?.map((offer) => (
        <Text key={offer.key}>
          {offer.key}: {offer.price}
        </Text>
      ))}
      <Text>Recent diagnostics</Text>
      {recent.length === 0 ? <Text>No local diagnostics yet.</Text> : null}
      {recent.map((event, index) => (
        <Text key={`${event.time}:${event.event}:${index}`}>
          {event.level} {event.event}
          {event.code ? ` ${event.code}` : ""}{" "}
          {event.scanId ? event.scanId.slice(0, 8) : ""}
        </Text>
      ))}
    </ScrollView>
  );
}
