"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OtpInput } from "@/components/otp-input";
import { authClient, type OTPPurpose } from "@/app/auth-client";
import { normalizeDigits, useWebOTP } from "./useWebOTP";
import Image from "next/image";
type Flow =
  | { kind: "login" }
  | { kind: "phone"; purpose: OTPPurpose }
  | { kind: "otp"; purpose: OTPPurpose; id: string; until: number }
  | { kind: "details"; purpose: OTPPurpose; ticket: string }
  | { kind: "complete" };
export function AuthScreen() {
  const [flow, setFlow] = useState<Flow>({ kind: "login" });
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [visible, setVisible] = useState(false);
  const [eyeAnimation, setEyeAnimation] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notRegistered, setNotRegistered] = useState(false);
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const gate = useRef(false);
  const webOTP = useWebOTP();
  const ticket = useRef("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  function navigate(next: Flow) {
    generation.current++;
    webOTP.cancel();
    setFlow(next);
    setError("");
    setNotRegistered(false);
    setPassword("");
    setConfirm("");
  }
  async function start(purpose: OTPPurpose) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    const current = generation.current;
    webOTP.start();
    try {
      const result = await authClient.startOTP(normalizeDigits(phone), purpose);
      if (current !== generation.current) return;
      if (result.error) {
        webOTP.cancel();
        setError(result.error.message);
        return;
      }
      setFlow({
        kind: "otp",
        purpose,
        id: result.data.challengeId,
        until: Date.now() + result.data.resendAfter * 1000,
      });
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flow.kind === "phone") {
      await start(flow.purpose);
      return;
    }
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      if (flow.kind === "login") {
        const result = await authClient.signIn.phone({
          phone: normalizeDigits(phone),
          password,
        });
        setNotRegistered(result.error?.status === 404);
        if (result.error)
          setError(
            result.error.status === 400 || result.error.status === 401
              ? "شماره همراه یا رمز عبور درست نیست. اگر هنوز حساب ندارید، ابتدا ثبت‌نام کنید."
              : result.error.message
          );
      } else if (flow.kind === "details") {
        if (password !== confirm) {
          setError("رمزهای عبور یکسان نیستند.");
          return;
        }
        const result =
          flow.purpose === "registration"
            ? await authClient.signUp.phone({
                ticket: flow.ticket,
                name,
                password,
              })
            : await authClient.resetPassword(flow.ticket, password);
        if (result.error) setError(result.error.message);
        else if (flow.purpose === "password_reset")
          navigate({ kind: "complete" });
      }
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  const title =
    flow.kind === "login"
      ? "به بهتر بخر خوش آمدید"
      : flow.kind === "phone"
        ? flow.purpose === "registration"
          ? "ساخت حساب کاربری"
          : "بازیابی رمز عبور"
        : flow.kind === "otp"
          ? "تأیید شماره همراه"
          : flow.kind === "details"
            ? "یک قدم تا پایان"
            : "رمز عبور تغییر کرد";
  return (
    <main className="phone-auth" dir="rtl">
      <aside className="auth-story" aria-label="درباره بهتر بخر">
        <a className="auth-wordmark" href="/">
          بهتر بخر<span>Better Buy</span>
        </a>
        <div className="auth-introduction">
          <h2>خریدهای همیشگی، انتخاب‌های بهتر.</h2>
          <p>
            تخفیف فروشگاه‌های اطرافتان را مقایسه کنید و پیشنهادهای مناسب سبدتان
            را پیدا کنید.
          </p>
        </div>
        <figure className="auth-receipt" aria-label="نمونه فهرست خرید">
          <figcaption>نمونه فهرست خرید</figcaption>
          <ul>
            <li>
              <span>شیر</span>
              <span>یک پاکت</span>
            </li>
            <li>
              <span>پنیر</span>
              <span>یک بسته</span>
            </li>
            <li>
              <span>بیسکویت</span>
              <span>یک بسته</span>
            </li>
            <li>
              <span>چیپس</span>
              <span>یک بسته</span>
            </li>
          </ul>
          <p>همان خرید، با انتخاب بهتر.</p>
        </figure>
        <div className="auth-supported-stores">
          <span>مقایسه پیشنهادهای</span>
          <Image
            src="/providers/snappmarket.png"
            alt="اسنپ‌مارکت"
            width={88}
            height={32}
            unoptimized
          />
          <Image
            src="/providers/okala.png"
            alt="اکالا"
            width={64}
            height={32}
            unoptimized
          />
        </div>
      </aside>
      <section className="phone-auth-card" data-step={flow.kind}>
        <header>
          <h1>{title}</h1>
          <p>
            {flow.kind === "login"
              ? "برای ادامه خرید، وارد حساب خود شوید."
              : flow.kind === "phone" && flow.purpose === "registration"
                ? "اول شماره همراهتان را تأیید می‌کنیم؛ بعد حساب می‌سازید."
                : flow.kind === "phone"
                  ? "شماره همراه حساب خود را وارد کنید."
                  : flow.kind === "details"
                    ? "اطلاعات زیر را تکمیل کنید."
                    : flow.kind === "otp"
                      ? "کد تأیید پیامک‌شده را وارد کنید."
                      : "اکنون می‌توانید با رمز جدید وارد شوید."}
          </p>
        </header>
        {error && (
          <p role="alert" className="phone-auth-error">
            {error}
          </p>
        )}
        {notRegistered && flow.kind === "login" && (
          <Button
            className="auth-register-button"
            onClick={() => navigate({ kind: "phone", purpose: "registration" })}
          >
            ثبت‌نام با همین شماره
          </Button>
        )}
        {flow.kind === "otp" ? (
          <>
            <p>
              کد ارسال‌شده به{" "}
              <bdi dir="ltr">{normalizeDigits(phone).slice(0, -4)}••••</bdi> را
              وارد کنید.
            </p>
            <OtpInput
              key={flow.id}
              enableSound={false}
              value={webOTP.code}
              verify={async (code) => {
                webOTP.cancel();
                if (gate.current) return false;
                gate.current = true;
                try {
                  const result = await authClient.verifyOTP(flow.id, code);
                  if (result.error) {
                    setError(result.error.message);
                    return false;
                  }
                  ticket.current = result.data.ticket;
                  return true;
                } finally {
                  gate.current = false;
                }
              }}
              onVerified={() =>
                navigate({
                  kind: "details",
                  purpose: flow.purpose,
                  ticket: ticket.current,
                })
              }
            />
            <p role="status">
              {Math.max(0, Math.ceil((flow.until - now) / 1000)) > 0
                ? `ارسال دوباره تا ${Math.max(0, Math.ceil((flow.until - now) / 1000))} ثانیه دیگر`
                : "می‌توانید کد جدید دریافت کنید."}
            </p>
            <Button
              disabled={busy || now < flow.until}
              onClick={() => void start(flow.purpose)}
            >
              ارسال دوباره کد
            </Button>
            <Button
              variant="ghost"
              onClick={() => navigate({ kind: "phone", purpose: flow.purpose })}
            >
              ویرایش شماره
            </Button>
          </>
        ) : flow.kind === "complete" ? (
          <>
            <p role="status">اکنون با رمز جدید وارد شوید.</p>
            <Button onClick={() => navigate({ kind: "login" })}>
              بازگشت به ورود
            </Button>
          </>
        ) : (
          <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
            <fieldset disabled={busy}>
              {(flow.kind === "login" || flow.kind === "phone") && (
                <label>
                  شماره همراه
                  <Input
                    dir="ltr"
                    type="tel"
                    autoComplete="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(normalizeDigits(e.target.value))}
                    pattern="(09[0-9]{9}|989[0-9]{9}|\+989[0-9]{9})"
                    placeholder="09123456789"
                  />
                </label>
              )}
              {flow.kind === "details" && flow.purpose === "registration" && (
                <label>
                  نام شما
                  <Input
                    autoComplete="name"
                    required
                    maxLength={120}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              )}
              {(flow.kind === "login" || flow.kind === "details") && (
                <>
                  <label htmlFor="auth-password">رمز عبور</label>
                  <div className="password-input-wrap">
                    <Input
                      id="auth-password"
                      dir="ltr"
                      type={visible ? "text" : "password"}
                      autoComplete={
                        flow.kind === "login"
                          ? "current-password"
                          : "new-password"
                      }
                      required
                      minLength={12}
                      maxLength={1024}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="password-eye-toggle"
                      aria-label={visible ? "پنهان کردن رمز" : "نمایش رمز"}
                      aria-pressed={visible}
                      aria-controls="auth-password"
                      onClick={() => {
                        setVisible(!visible);
                        setEyeAnimation((value) => value + 1);
                      }}
                    >
                      <svg
                        key={eyeAnimation}
                        className={
                          eyeAnimation
                            ? "password-eye is-blinking"
                            : "password-eye"
                        }
                        width="24"
                        height="24"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <g className="password-eye-lid">
                          <path
                            d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                          <circle cx="12" cy="12" r="3" fill="currentColor" />
                          <circle cx="13" cy="11" r="0.8" fill="var(--card)" />
                        </g>
                        {!visible && (
                          <path
                            d="m4 4 16 16"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        )}
                      </svg>
                    </Button>
                  </div>
                  {flow.kind === "details" && (
                    <>
                      <p>
                        حداقل ۱۲ نویسه؛ می‌توانید یک عبارت طولانی انتخاب کنید.
                      </p>
                      <label>
                        تکرار رمز عبور
                        <Input
                          dir="ltr"
                          type={visible ? "text" : "password"}
                          autoComplete="new-password"
                          required
                          value={confirm}
                          onChange={(e) => setConfirm(e.target.value)}
                        />
                      </label>
                    </>
                  )}
                </>
              )}
              <Button type="submit">
                {busy
                  ? "در حال انجام…"
                  : flow.kind === "login"
                    ? "ورود"
                    : flow.kind === "phone"
                      ? "دریافت کد تأیید"
                      : flow.purpose === "registration"
                        ? "ساخت حساب"
                        : "ذخیره رمز جدید"}
              </Button>
            </fieldset>
          </form>
        )}
        {flow.kind === "login" ? (
          <nav aria-label="گزینه‌های ورود">
            <Button
              variant="link"
              onClick={() =>
                navigate({ kind: "phone", purpose: "password_reset" })
              }
            >
              رمز عبور را فراموش کرده‌ام
            </Button>
            <p className="auth-register-prompt">هنوز حساب ندارید؟</p>
            <Button
              variant="outline"
              className="auth-register-button"
              onClick={() =>
                navigate({ kind: "phone", purpose: "registration" })
              }
            >
              ساخت حساب کاربری
            </Button>
          </nav>
        ) : (
          <Button variant="link" onClick={() => navigate({ kind: "login" })}>
            بازگشت به ورود
          </Button>
        )}
        <div className="auth-guest-access">
          <Button asChild variant="secondary" className="auth-guest-link">
            <a href="/">
              ادامه بدون ورود
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M19 12H5m6-6-6 6 6 6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </Button>
        </div>
      </section>
    </main>
  );
}
