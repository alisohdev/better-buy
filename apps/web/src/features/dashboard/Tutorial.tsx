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
  tutorialSteps,
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
  navigation: { step: TutorialStep; id: number } | null;
  previous: () => void;
  next: () => void;
  canPrevious: boolean;
  canNext: boolean;
}>({
  step: null,
  start: () => {},
  send: () => {},
  dismiss: () => {},
  navigation: null,
  previous: () => {},
  next: () => {},
  canPrevious: false,
  canNext: false,
});
export const useTutorial = () => useContext(TutorialContext);

export function TutorialProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<TutorialStep | null>(null);
  const stepRef = useRef<TutorialStep | null>(null);
  stepRef.current = step;
  const [furthest, setFurthest] = useState(0);
  const [navigation, setNavigation] = useState<{
    step: TutorialStep;
    id: number;
  } | null>(null);
  const reviewing = useRef(false);
  const index = step ? tutorialSteps.indexOf(step) : -1;
  const navigate = (direction: number) => {
    const target = tutorialSteps[index + direction];
    if (!target || index + direction > furthest) return;
    reviewing.current = true;
    stepRef.current = target;
    setStep(target);
    setNavigation((previous) => ({
      step: target,
      id: (previous?.id ?? 0) + 1,
    }));
  };
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
        start: () => {
          reviewing.current = false;
          setFurthest(0);
          setStep("location");
        },
        navigation,
        previous: () => navigate(-1),
        next: () => navigate(1),
        canPrevious: index > 0,
        canNext: index >= 0 && index < furthest,
        send: (event) => {
          if (
            reviewing.current &&
            ["scan-succeeded", "scan-failed"].includes(event)
          )
            return;
          reviewing.current = false;
          const target = tutorialTransition(stepRef.current, event);
          stepRef.current = target;
          setStep(target);
          if (target)
            setFurthest((previous) =>
              Math.max(previous, tutorialSteps.indexOf(target))
            );
        },
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
    "روی «مشاهده نتایج» بزنید تا پیشنهادهای این موقعیت را ببینید.",
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
  return (
    <aside
      ref={ref}
      className="tutorial-hint"
      aria-label="راهنمای عملی بهتر بخر"
      data-tutorial-step={at}
    >
      <div role="status" aria-live="polite" aria-atomic="true">
        <span className="tutorial-progress" dir="ltr">
          {tutorialSteps.indexOf(at) + 1} / {tutorialSteps.length}
        </span>
        <strong>{copy[at][0]}</strong>
        <p>{copy[at][1]}</p>
      </div>
      <div className="tutorial-actions">
        <div className="tutorial-navigation" aria-label="جابه‌جایی در راهنما">
          <Button
            type="button"
            variant="outline"
            aria-label="مرحله قبلی"
            disabled={!tour.canPrevious}
            onClick={tour.previous}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m9 5 7 7-7 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
          <Button
            type="button"
            variant="outline"
            aria-label="مرحله بعدی"
            title={
              tour.canNext ? "مرحله بعدی" : "ابتدا کار این مرحله را انجام دهید"
            }
            disabled={!tour.canNext}
            onClick={tour.next}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="m15 5-7 7 7 7"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Button>
        </div>
        <Button type="button" variant="outline" onClick={tour.dismiss}>
          {at === "done" ? "پایان راهنما" : "رد کردن راهنما"}
        </Button>
      </div>
    </aside>
  );
}
