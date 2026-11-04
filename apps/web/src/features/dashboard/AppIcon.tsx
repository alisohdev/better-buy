import type { SVGProps } from "react";

type IconName =
  | "menu"
  | "cart"
  | "heart"
  | "bell"
  | "history"
  | "home"
  | "close"
  | "plus"
  | "check"
  | "back"
  | "basket"
  | "list"
  | "scan"
  | "external"
  | "location";

export function AppIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {name === "menu" && <path d="M4 6h16M4 12h16M4 18h16" />}
      {name === "cart" && (
        <>
          <path d="M3 3h2l2.4 12h11.2L21 7H6" />
          <circle cx="9" cy="20" r="1" />
          <circle cx="18" cy="20" r="1" />
        </>
      )}
      {name === "heart" && (
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
      )}
      {name === "bell" && (
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
      )}
      {name === "history" && (
        <path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2" />
      )}
      {name === "home" && <path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8" />}
      {name === "close" && <path d="m6 6 12 12M6 18 18 6" />}
      {name === "plus" && <path d="M12 5v14M5 12h14" />}
      {name === "check" && <path d="m5 12 4 4L19 6" />}
      {name === "back" && <path d="m15 18-6-6 6-6" />}
      {name === "basket" && (
        <>
          <path d="m5 10 1 10h12l1-10H5Z" />
          <path d="m8 10 4-7 4 7M9 13v4M12 13v4M15 13v4" />
        </>
      )}
      {name === "list" && (
        <>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="M4 6h.01M4 12h.01M4 18h.01" />
        </>
      )}
      {name === "scan" && (
        <>
          <path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M3 17v2a2 2 0 0 0 2 2h2" />
          <path d="M8 12h8M12 8v8" />
        </>
      )}
      {name === "external" && (
        <path d="M14 3h7v7M21 3l-11 11M10 3H3v18h18v-7" />
      )}
      {name === "location" && (
        <>
          <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
          <circle cx="12" cy="10" r="2.5" />
        </>
      )}
    </svg>
  );
}

export function ProviderMark({
  source,
}: {
  source: "snappmarket" | "okala" | "digikalajet";
}) {
  if (source === "digikalajet") return null;
  return (
    <img
      className="provider-mark"
      src={`/providers/${source}.png`}
      alt=""
      width={24}
      height={24}
    />
  );
}
