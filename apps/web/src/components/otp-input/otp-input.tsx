"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useTypedText } from "@/lib/typing-sound";
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useReducedMotion,
  MotionConfig,
} from "framer-motion";
import { useSound } from "@/lib/ui-sounds";

type Status = "idle" | "verifying" | "error" | "success" | "done";

export interface OtpInputProps {
  length?: number;
  value?: string;
  /** Return true when the code is valid. Verification is supplied by the backend. */
  verify?: (code: string) => boolean | Promise<boolean>;

  accent?: string;
  /** Called once a code verifies. */
  onVerified?: (code: string) => void;
  /** Plays interface sounds on interaction. They follow the site-wide sound switch. Autoplay makes the same sounds once the visitor has used the page. */
  enableSound?: boolean;
}

const spring = { type: "spring", stiffness: 500, damping: 30 } as const;

export function OtpInput({
  length = 6,
  verify = () => false,
  value: suppliedValue,

  accent = "#C3CDFF",
  onVerified,
  enableSound = false,
}: OtpInputProps) {
  const uid = useId();
  const reduce = useReducedMotion();
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      submitting.current = false;
      timers.current.forEach(clearTimeout);
    };
  }, []);
  const play = useSound(enableSound);
  const [code, setCode] = useState("");
  useTypedText(code, enableSound);
  const [status, setStatus] = useState<Status>("idle");
  const [focused, setFocused] = useState(false);
  const [showError, setShowError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const touched = useRef(false);
  const shake = useAnimationControls();
  const timers = useRef<number[]>([]);
  const playRef = useRef(play);
  useEffect(() => {
    playRef.current = play;
  });

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  // `audible` is true for codes the visitor typed; the autoplay demo answers through `play.auto`.
  const submit = async (value: string, audible = false) => {
    if (submitting.current) return;
    submitting.current = true;
    setStatus("verifying");
    let ok = false;
    try {
      ok = await verify(value);
    } catch {
      ok = false;
    }
    if (!mounted.current) return;
    if (ok) {
      if (audible) play("success");
      else playRef.current.auto("success");
      setStatus("success");
      later(
        () => {
          setStatus("done");
          later(() => onVerified?.(value), reduce ? 0 : 650);
        },
        reduce ? 0 : 650
      );
    } else {
      if (audible) play("error");
      else playRef.current.auto("error");
      setStatus("error");
      setShowError(true);
      if (!reduce)
        void shake.start({
          x: [0, -14, 12, -9, 7, -4, 0],
          transition: { duration: 0.5 },
        });
      later(
        () => {
          setCode("");
          setStatus("idle");
          submitting.current = false;
        },
        reduce ? 0 : 600
      );
    }
  };

  const handle = (raw: string) => {
    if (status === "verifying" || status === "success" || status === "done")
      return;
    const value = raw
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/\D/g, "")
      .slice(0, length);
    if (value.length > code.length) play("tick", 0.45);
    setCode(value);
    if (value.length) setShowError(false);
    if (value.length === length) submit(value, true);
  };

  const reset = () => {
    clearTimers();
    setCode("");
    setStatus("idle");
    setShowError(false);
  };

  useEffect(() => {
    if (suppliedValue) handle(suppliedValue);
  }, [suppliedValue]);

  const takeOver = () => {
    if (touched.current) return;
    touched.current = true;
    reset();
  };

  const locked =
    status === "verifying" || status === "success" || status === "done";
  const activeIndex = Math.min(code.length, length - 1);
  const center = (length - 1) / 2;
  // The row keeps the width of its boxes even after they leave, so the تأیید شد pill stays centred.
  const gapAfter = (i: number) =>
    i === length - 1 ? 0 : i === length / 2 - 1 ? 22 : 10;
  const rowWidth = Array.from({ length }, (_, i) => 40 + gapAfter(i)).reduce(
    (a, b) => a + b,
    0
  );

  return (
    <MotionConfig reducedMotion={reduce ? "always" : "never"}>
      <div
        dir="ltr"
        className="nexus-otp flex flex-col items-center gap-6 [--otp-box:#ffffff] [--otp-ink:#1d1d1f] [--otp-line:#d2d2d7] [--otp-line-on:#aeaeb2] dark:[--otp-box:#2c2c2e] dark:[--otp-ink:#f5f5f7] dark:[--otp-line:#48484a] dark:[--otp-line-on:#7c7c80]"
      >
        <motion.div
          animate={shake}
          className="relative flex h-[58px] items-center"
          style={{ width: rowWidth }}
        >
          <AnimatePresence initial={false}>
            {status !== "done" &&
              Array.from({ length }).map((_, i) => {
                const filled = i < code.length;
                const isActive =
                  focused &&
                  !locked &&
                  i === activeIndex &&
                  code.length < length;
                const isError = status === "error";
                const isSuccess = status === "success";
                return (
                  <motion.div
                    key={`box-${i}`}
                    custom={i}
                    initial={{ opacity: 0, y: 24, scale: 0.85 }}
                    animate={
                      status === "verifying" && !reduce
                        ? {
                            opacity: 1,
                            scale: 1,
                            y: [0, -8, 0],
                            transition: {
                              y: {
                                duration: 0.8,
                                repeat: Infinity,
                                delay: i * 0.07,
                                ease: "easeInOut",
                              },
                            },
                          }
                        : {
                            opacity: 1,
                            scale: 1,
                            y: 0,
                            x: 0,
                            transition: spring,
                          }
                    }
                    exit={{
                      x: (center - i) * 64,
                      scale: 0.3,
                      opacity: 0,
                      transition: {
                        type: "spring",
                        stiffness: 260,
                        damping: 26,
                        delay: Math.abs(center - i) * 0.03,
                      },
                    }}
                    className="relative flex h-[58px] w-[40px] items-center justify-center rounded-2xl transition-colors duration-300"
                    style={{
                      backgroundColor: isSuccess ? accent : "var(--otp-box)",
                      transitionDelay: isSuccess ? `${i * 50}ms` : "0ms",
                      marginRight: gapAfter(i),
                      boxShadow: isError
                        ? "inset 0 0 0 2px #ff3b30, 0 0 0 5px rgba(255,59,48,.10)"
                        : filled
                          ? "inset 0 0 0 1px var(--otp-line-on), 0 1px 2px rgba(0,0,0,.04)"
                          : "inset 0 0 0 1px var(--otp-line), 0 1px 2px rgba(0,0,0,.04)",
                    }}
                  >
                    {isActive && (
                      <motion.div
                        layoutId={`${uid}-ring`}
                        transition={{
                          type: "spring",
                          stiffness: 520,
                          damping: 38,
                        }}
                        className="absolute inset-0 rounded-2xl"
                        style={{
                          boxShadow: `inset 0 0 0 2px ${accent}, 0 0 0 5px ${accent}24`,
                        }}
                      />
                    )}
                    <AnimatePresence mode="popLayout" initial={false}>
                      {filled ? (
                        <motion.span
                          key={`${code[i] ?? ""}-${i}`}
                          initial={{
                            y: 18,
                            opacity: 0,
                            scale: 0.4,
                            filter: "blur(6px)",
                          }}
                          animate={{
                            y: 0,
                            opacity: 1,
                            scale: 1,
                            filter: "blur(0px)",
                          }}
                          exit={{
                            y: -14,
                            opacity: 0,
                            scale: 0.6,
                            filter: "blur(4px)",
                          }}
                          transition={{
                            type: "spring",
                            stiffness: 520,
                            damping: 24,
                          }}
                          className="text-[30px] font-semibold tracking-tight"
                          style={{
                            color: isSuccess ? "#fff" : "var(--otp-ink)",
                          }}
                        >
                          {code[i]}
                        </motion.span>
                      ) : (
                        isActive && (
                          <motion.span
                            key="caret"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: reduce ? 1 : [1, 1, 0, 0] }}
                            transition={{
                              duration: 1,
                              repeat: Infinity,
                              times: [0, 0.5, 0.5, 1],
                            }}
                            className="h-[30px] w-[2px] rounded-full"
                            style={{ background: accent }}
                          />
                        )
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
          </AnimatePresence>

          <AnimatePresence>
            {status === "done" && (
              <motion.div
                key="ok"
                role="status"
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={{
                  type: "spring",
                  stiffness: 380,
                  damping: 20,
                  delay: 0.15,
                }}
                className="absolute inset-0 m-auto flex h-[58px] w-max items-center gap-3 rounded-full bg-[#1d1d1f] ps-2.5 pe-6 text-[17px] font-semibold text-white shadow-[0_20px_40px_-16px_rgba(0,0,0,.35)] dark:bg-[#f5f5f7] dark:text-[#1d1d1f]"
              >
                <span
                  className="flex h-[38px] w-[38px] items-center justify-center rounded-full"
                  style={{ background: accent }}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                  >
                    <motion.path
                      d="M6 12.5l4 4L18 8.5"
                      stroke="#fff"
                      strokeWidth={2.6}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{
                        duration: 0.45,
                        delay: 0.35,
                        ease: [0.65, 0, 0.35, 1],
                      }}
                    />
                  </svg>
                </span>
                تأیید شد
              </motion.div>
            )}
          </AnimatePresence>

          <label htmlFor={`${uid}-field`} className="sr-only">
            کد تأیید شش رقمی
          </label>
          <input
            id={`${uid}-field`}
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={32}
            dir="ltr"
            aria-invalid={showError}
            aria-busy={status === "verifying"}
            value={code}
            disabled={locked}
            onChange={(e) => {
              takeOver();
              handle(e.target.value);
            }}
            onFocus={() => {
              takeOver();
              setFocused(true);
            }}
            onBlur={() => setFocused(false)}
            className="absolute inset-0 h-full w-full cursor-text bg-transparent text-[16px] text-transparent caret-transparent opacity-0 disabled:cursor-default"
          />
        </motion.div>

        <div className="flex h-11 items-center justify-center text-[15px] text-[#6e6e73] dark:text-[#a1a1a6]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={
                status === "done"
                  ? "done"
                  : status === "verifying" || status === "success"
                    ? "checking"
                    : showError
                      ? "error"
                      : "idle"
              }
              initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-2"
            >
              {status === "done" ? (
                <span role="status">تأیید شد</span>
              ) : status === "verifying" || status === "success" ? (
                <>
                  <motion.span
                    className="h-4 w-4 rounded-full border-2 border-[var(--otp-line)]"
                    style={{ borderTopColor: accent }}
                    animate={{ rotate: reduce ? 0 : 360 }}
                    transition={{
                      duration: 0.7,
                      repeat: Infinity,
                      ease: "linear",
                    }}
                  />
                  در حال بررسی…
                </>
              ) : showError ? (
                <span className="text-[#d70015] dark:text-[#ff6961]">
                  کد معتبر نیست؛ دوباره تلاش کنید.
                </span>
              ) : (
                <span> </span>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </MotionConfig>
  );
}
