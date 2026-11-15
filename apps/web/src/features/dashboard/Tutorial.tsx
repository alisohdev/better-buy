"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  tutorialTransition,
  type TutorialEvent,
  type TutorialStep,
} from "./tutorialState";
import { TutorialSpotlight } from "./TutorialSpotlight";
import "./tutorial.css";

const storageKey = "better-buy:tutorial:v2";
const TutorialContext = createContext<{
  step: TutorialStep | null;
  start: () => void;
  send: (event: TutorialEvent) => void;
  dismiss: () => void;
}>({ step: null, start: () => {}, send: () => {}, dismiss: () => {} });
export const useTutorial = () => useContext(TutorialContext);

export function TutorialProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<TutorialStep | null>(null);
  useEffect(() => {
    try {
      if (!localStorage.getItem(storageKey)) setStep("location");
    } catch {
      /* Help can still start the guide when storage is unavailable. */
    }
  }, []);
  const dismiss = () => {
    setStep(null);
    try {
      localStorage.setItem(storageKey, "dismissed");
    } catch {
      /* Storage is optional. */
    }
  };
  return (
    <TutorialContext.Provider
      value={{
        step,
        start: () => setStep("location"),
        send: (event) =>
          setStep((current) => tutorialTransition(current, event)),
        dismiss,
      }}
    >
      {children}
      <TutorialSpotlight step={step} />
    </TutorialContext.Provider>
  );
}

const copy: Record<TutorialStep, [string, string]> = {
  location: [
    "اول یک موقعیت اضافه کنید",
    "دکمه مشخص‌شده را بزنید تا آدرس تحویل را روی نقشه ثبت کنید. راهنما تا ذخیره موفق آدرس منتظر شما می‌ماند.",
  ],
  map: [
    "آدرس را روی نقشه مشخص کنید",
    "محله یا خیابان را جست‌وجو کنید یا نقشه را جابه‌جا کنید؛ سپس «تأیید موقعیت» را بزنید.",
  ],
  details: [
    "برای موقعیت نام بگذارید",
    "مثلاً «خانه» را انتخاب کنید و «ذخیره مکان» را بزنید. اگر ذخیره انجام نشود، همین‌جا می‌مانیم.",
  ],
  scan: [
    "حالا خودتان اسکن را شروع کنید",
    "فروشگاه‌ها را انتخاب کنید، سپس دکمه «شروع اسکن» را بزنید تا تخفیف‌های این موقعیت دریافت شوند.",
  ],
  waiting: [
    "منتظر نتیجه اسکن هستیم",
    "پیشرفت واقعی را همین‌جا می‌بینید. راهنما پس از دریافت نتیجه موفق ادامه پیدا می‌کند؛ اگر خطایی رخ دهد، دوباره تلاش کنید.",
  ],
  results: [
    "نتیجه آماده است",
    "روی «مشاهده نتایج» بزنید تا با فهرست کالاها کار کنیم.",
  ],
  search: [
    "یک کالا را جست‌وجو کنید",
    "در کادر مشخص‌شده نام یک کالا مثل «شیر» را بنویسید. نتیجه‌ها با جست‌وجوی شما تغییر می‌کنند.",
  ],
  product: [
    "یک محصول را باز کنید",
    "روی نام یا تصویر یکی از کالاها بزنید تا جزئیات آن باز شود. اگر نتیجه‌ای نیست، جست‌وجو را پاک کنید یا حداقل تخفیف را کم کنید.",
  ],
  done: [
    "اولین بررسی شما انجام شد",
    "در جزئیات، قیمت و زمان مشاهده را بررسی کنید و در صورت وجود چند پیشنهاد، فروشگاه‌ها را مقایسه کنید. برای نگهداری سبد و علاقه‌مندی‌ها وارد حساب شوید. راهنما همیشه از منوی برنامه در دسترس است.",
  ],
};
export function TutorialHint({ at }: { at: TutorialStep }) {
  const tour = useTutorial();
  const ref = useRef<HTMLElement>(null);
  const visible = tour.step === at;
  useEffect(() => {
    if (visible)
      ref.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, [visible]);
  if (!visible) return null;
  const steps: TutorialStep[] = [
    "location",
    "map",
    "details",
    "scan",
    "waiting",
    "results",
    "search",
    "product",
    "done",
  ];
  return (
    <aside
      ref={ref}
      className="tutorial-hint"
      aria-label="راهنمای عملی بهتر بخر"
      data-tutorial-step={at}
    >
      <div role="status" aria-live="polite" aria-atomic="true">
        <span className="tutorial-progress" dir="ltr">
          {steps.indexOf(at) + 1} / {steps.length}
        </span>
        <strong>{copy[at][0]}</strong>
        <p>{copy[at][1]}</p>
      </div>
      <Button type="button" variant="outline" onClick={tour.dismiss}>
        {at === "done" ? "پایان راهنما" : "رد کردن راهنما"}
      </Button>
    </aside>
  );
}
