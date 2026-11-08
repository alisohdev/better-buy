"use client";
import { useCallback, useEffect, useRef, useState } from "react";
export function normalizeDigits(value: string) {
  return value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
export function useWebOTP() {
  const controller = useRef<AbortController | null>(null);
  const [code, setCode] = useState("");
  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
  }, []);
  const start = useCallback(() => {
    cancel();
    setCode("");
    if (!("OTPCredential" in window) || !navigator.credentials) return;
    const active = new AbortController();
    controller.current = active;
    const options: CredentialRequestOptions & { otp: { transport: string[] } } =
      { otp: { transport: ["sms"] }, signal: active.signal };
    void navigator.credentials
      .get(options)
      .then((value) => {
        if (
          !active.signal.aborted &&
          value &&
          "code" in value &&
          typeof value.code === "string"
        )
          setCode(normalizeDigits(value.code));
      })
      .catch(() => {});
  }, [cancel]);
  useEffect(() => cancel, [cancel]);
  return { code, start, cancel };
}
