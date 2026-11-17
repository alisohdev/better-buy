"use client";
import { useState } from "react";
import { enablePush, disablePush } from "./push";
export function PushButtons() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function act(enable: boolean) {
    setBusy(true);
    setMessage("");
    try {
      await (enable ? enablePush() : disablePush());
      setMessage(enable ? "Notifications enabled" : "Notifications disabled");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Push settings failed"
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <button disabled={busy} onClick={() => act(true)}>
        Enable notifications
      </button>
      <button disabled={busy} onClick={() => act(false)}>
        Disable notifications
      </button>
      <p role="status">{message}</p>
    </section>
  );
}
