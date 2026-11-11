"use client";

import { useTheme } from "next-themes";

const choices = [
  { value: "light", label: "روشن" },
  { value: "dark", label: "تیره" },
  { value: "system", label: "سیستم" },
] as const;

export function AppearanceSwitch() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="appearance-switch">
      <span>ظاهر برنامه</span>
      <div role="group" aria-label="ظاهر برنامه">
        {choices.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            data-theme-choice={value}
            aria-pressed={theme === value}
            onClick={() => setTheme(value)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {value === "light" && (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path
                    className="sun-rays"
                    d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
                  />
                </>
              )}
              {value === "dark" && (
                <>
                  <path d="M20.7 13a8.7 8.7 0 0 1-9.7-9.7A8.8 8.8 0 1 0 20.7 13Z" />
                  <path className="moon-star" d="M18 3v4m-2-2h4" />
                </>
              )}
              {value === "system" && (
                <>
                  <rect x="3" y="4" width="18" height="13" rx="3" />
                  <path d="M8 21h8m-4-4v4" />
                  <path className="screen-spark" d="m10 11 2-2 2 2" />
                </>
              )}
            </svg>
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
