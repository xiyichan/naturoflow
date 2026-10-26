// Small line icons in the spirit of SF Symbols; they inherit the text color.
import type { SVGProps } from "react";

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

type P = SVGProps<SVGSVGElement>;

export const IconGlobe = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.6 3.9 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.3 5.4 8S6.3 3.6 8 1.8Z" />
  </svg>
);

export const IconSun = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="2.8" />
    <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
  </svg>
);

export const IconMoon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M13.6 9.6A5.9 5.9 0 0 1 6.4 2.4a5.9 5.9 0 1 0 7.2 7.2Z" />
  </svg>
);

/** Half-filled circle: follows the system appearance. */
export const IconAuto = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCheck = (p: P) => (
  <svg {...base} strokeWidth={1.8} {...p}>
    <path d="M3.5 8.4 6.6 11.4 12.5 4.8" />
  </svg>
);

export const IconChevronDown = (p: P) => (
  <svg {...base} width={10} height={10} strokeWidth={1.8} {...p}>
    <path d="M4 6.2 8 10l4-3.8" />
  </svg>
);

export const IconKeyboard = (p: P) => (
  <svg {...base} {...p}>
    <rect x="1.6" y="3.8" width="12.8" height="8.4" rx="1.6" />
    <path d="M4.2 6.6h.01M6.7 6.6h.01M9.3 6.6h.01M11.8 6.6h.01M4.2 9.4h.01M11.8 9.4h.01M6.4 9.4h3.2" strokeWidth={1.6} />
  </svg>
);

export const IconFlow = (p: P) => (
  <svg {...base} {...p}>
    <rect x="1.5" y="2.5" width="5" height="4" rx="1" />
    <rect x="9.5" y="9.5" width="5" height="4" rx="1" />
    <path d="M6.5 4.5h2.2a1.5 1.5 0 0 1 1.5 1.5v3.5" />
  </svg>
);

export const IconPhoto = (p: P) => (
  <svg {...base} {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.8" />
    <circle cx="5.6" cy="6.3" r="1.1" />
    <path d="m2.2 11.6 3.6-3.4 2.6 2.4 2.2-2 3.2 3" />
  </svg>
);

export const IconClock = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <path d="M8 4.6V8l2.3 1.5" />
  </svg>
);

export const IconStar = (p: P) => (
  <svg {...base} {...p}>
    <path d="m8 2 1.8 3.8 4.1.5-3 2.8.8 4.1L8 11.2l-3.7 2 .8-4.1-3-2.8 4.1-.5Z" />
  </svg>
);
