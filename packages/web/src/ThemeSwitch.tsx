import { useState } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "naturoflow.theme";

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Appearance: follow the system, or force light / dark (remembered per browser). */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(read);
  const pick = (t: Theme) => {
    setTheme(t);
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  };
  const opts: [Theme, string, string][] = [
    ["system", "自动", "跟随系统外观"],
    ["light", "浅色", "浅色外观"],
    ["dark", "深色", "深色外观"],
  ];
  return (
    <div className="nf-seg nf-theme" role="radiogroup" aria-label="外观">
      {opts.map(([t, label, title]) => (
        <button key={t} role="radio" aria-checked={theme === t} title={title} onClick={() => pick(t)}>
          {label}
        </button>
      ))}
    </div>
  );
}
