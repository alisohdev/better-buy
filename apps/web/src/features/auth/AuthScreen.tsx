"use client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { authClient } from "../../app/auth-client";

type AuthMode = "sign-in" | "sign-up";
type PendingAuth = null | "email" | "google";
type AuthFeedback = AuthMode | "google" | "sign-in-session" | "sign-up-session";

const feedbackMessages = {
  "sign-in":
    "ورود انجام نشد. ایمیل و رمز عبور را بررسی کنید یا با گوگل ادامه دهید.",
  "sign-up":
    "ثبت‌نام انجام نشد. دوباره تلاش کنید، وارد حساب شوید یا با گوگل ادامه دهید.",
  google: "شروع ورود با گوگل ممکن نشد؛ دوباره تلاش کنید.",
  "sign-in-session": "ورود در مرورگر تأیید نشد. لطفاً دوباره وارد شوید.",
  "sign-up-session":
    "حساب ممکن است ساخته شده باشد، اما ورود در مرورگر تأیید نشد. لطفاً با ایمیل و رمز عبور دوباره وارد شوید.",
} satisfies Record<AuthFeedback, string>;

export function AuthScreen() {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [pending, setPending] = useState<PendingAuth>(null);
  const [feedback, setFeedback] = useState<AuthFeedback | null>(null);
  const attempt = useRef<PendingAuth>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLParagraphElement>(null);
  const busy = pending !== null;

  useEffect(() => {
    if (feedback) feedbackRef.current?.focus();
  }, [feedback]);

  const submitEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (attempt.current !== null) return;

    const emailInput = emailRef.current;
    const passwordInput = passwordRef.current;
    if (!emailInput || !passwordInput) return;
    emailInput.value = emailInput.value.trim();
    if (!event.currentTarget.reportValidity()) return;

    const email = emailInput.value;
    const submittedMode = mode;
    attempt.current = "email";
    setPending("email");
    setFeedback(null);
    let navigating = false;

    try {
      const result =
        submittedMode === "sign-up"
          ? await authClient.signUp.email({
              name: email.split("@")[0] || "Better Buy user",
              email,
              password: passwordInput.value,
            })
          : await authClient.signIn.email({
              email,
              password: passwordInput.value,
            });
      if (result.error) {
        setFeedback(submittedMode);
        return;
      }

      const session = await authClient.getSession().catch(() => null);
      if (!session?.data?.user) {
        setFeedback(
          submittedMode === "sign-up" ? "sign-up-session" : "sign-in-session"
        );
        if (submittedMode === "sign-up") setMode("sign-in");
        return;
      }

      window.location.replace(
        window.location.pathname + window.location.search
      );
      navigating = true;
    } catch {
      setFeedback(submittedMode);
    } finally {
      passwordInput.value = "";
      if (!navigating) {
        attempt.current = null;
        setPending(null);
      }
    }
  };

  const signInWithGoogle = async () => {
    if (attempt.current !== null) return;
    if (passwordRef.current) passwordRef.current.value = "";
    attempt.current = "google";
    setPending("google");
    setFeedback(null);
    let failed = false;
    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: window.location.pathname + window.location.search,
      });
      failed = Boolean(result.error);
    } catch {
      failed = true;
    }
    if (!failed) return;
    setFeedback("google");
    attempt.current = null;
    setPending(null);
  };

  const switchMode = () => {
    if (attempt.current !== null) return;
    if (passwordRef.current) passwordRef.current.value = "";
    setMode(mode === "sign-in" ? "sign-up" : "sign-in");
    setFeedback(null);
  };

  return (
    <main className="auth-shell">
      <Card className="auth-card" aria-labelledby="sign-in-title">
        <div className="auth-mark">ب</div>
        <h1 id="sign-in-title">بهتر بخر</h1>
        <p>
          پیشنهادهای اسنپ‌مارکت و اکالا را برای موقعیت تحویل خود پیدا کنید و
          قیمت فروشگاه‌ها را مقایسه کنید.
        </p>
        <form noValidate onSubmit={(event) => void submitEmail(event)}>
          <fieldset
            disabled={busy}
            className="grid min-w-0 gap-4 border-0 p-0"
            aria-busy={pending === "email"}
          >
            <legend className="mb-4 text-lg font-semibold">
              {mode === "sign-in" ? "ورود با ایمیل" : "ساخت حساب با ایمیل"}
            </legend>
            <div className="grid gap-2">
              <Label htmlFor="auth-email">ایمیل</Label>
              <Input
                ref={emailRef}
                id="auth-email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                dir="ltr"
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="auth-password">رمز عبور</Label>
              <Input
                key={mode}
                ref={passwordRef}
                id="auth-password"
                name="password"
                type="password"
                autoComplete={
                  mode === "sign-in" ? "current-password" : "new-password"
                }
                aria-describedby="auth-password-hint"
                dir="ltr"
                minLength={8}
                maxLength={128}
                required
              />
              <p
                id="auth-password-hint"
                className="text-xs text-muted-foreground"
              >
                رمز عبور باید بین ۸ تا ۱۲۸ نویسه باشد.
              </p>
            </div>
            <Button type="submit" className="w-full">
              {pending === "email"
                ? mode === "sign-in"
                  ? "در حال ورود…"
                  : "در حال ساخت حساب…"
                : mode === "sign-in"
                  ? "ورود با ایمیل"
                  : "ساخت حساب"}
            </Button>
          </fieldset>
        </form>
        <Button
          type="button"
          variant="ghost"
          className="mt-3 w-full whitespace-normal"
          disabled={busy}
          onClick={switchMode}
        >
          {mode === "sign-in"
            ? "حساب ندارید؟ ثبت‌نام کنید"
            : "حساب دارید؟ وارد شوید"}
        </Button>
        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
          <span>یا</span>
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
        </div>
        <Button
          type="button"
          variant="outline"
          className="google-button"
          onClick={() => void signInWithGoogle()}
          disabled={busy}
          aria-busy={pending === "google"}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="#4285f4"
              d="M21.35 12.25c0-.7-.06-1.22-.2-1.77H12v3.34h5.37c-.11.83-.71 2.08-2.04 2.92l-.02.11 2.96 2.29.2.02c1.87-1.72 2.88-4.25 2.88-6.91Z"
            />
            <path
              fill="#34a853"
              d="M12 21.75c2.63 0 4.84-.87 6.45-2.36l-3.07-2.42c-.82.57-1.92.97-3.38.97-2.58 0-4.77-1.71-5.55-4.07l-.1.01-3.08 2.38-.04.1A9.75 9.75 0 0 0 12 21.75Z"
            />
            <path
              fill="#fbbc05"
              d="M6.45 13.87A5.87 5.87 0 0 1 6.14 12c0-.65.11-1.28.3-1.87v-.12l-3.11-2.42-.1.05A9.75 9.75 0 0 0 2.25 12c0 1.57.38 3.06.98 4.36l3.22-2.49Z"
            />
            <path
              fill="#ea4335"
              d="M12 6.06c1.84 0 3.08.8 3.79 1.46l2.77-2.7C16.83 3.2 14.63 2.25 12 2.25a9.75 9.75 0 0 0-8.77 5.39l3.21 2.49C7.23 7.77 9.42 6.06 12 6.06Z"
            />
          </svg>
          {pending === "google" ? "در حال باز کردن گوگل…" : "ادامه با گوگل"}
        </Button>
        {feedback && (
          <p
            ref={feedbackRef}
            className="auth-error"
            role="alert"
            aria-live="polite"
            tabIndex={-1}
          >
            {feedbackMessages[feedback]}
          </p>
        )}
        <small>
          موقعیت‌ها و تاریخچه در حساب شما نگهداری می‌شوند. برای بررسی پیشنهادها،
          ورود به فروشگاه لازم نیست.
        </small>
      </Card>
    </main>
  );
}
