import { useState } from "react";
import { lang, setLang, t, type Lang } from "./i18n.ts";

type Theme = "system" | "light" | "dark";
const KEY = "naturoflow.theme";

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Appearance: follow the system, or force light / dark (remembered per browser). */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(read);
  const pick = (v: Theme) => {
    setTheme(v);
    if (v === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
    try {
      if (v === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, v);
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  };
  const opts: [Theme, string, string][] = [
    ["system", t("自动"), t("跟随系统外观")],
    ["light", t("浅色"), t("浅色外观")],
    ["dark", t("深色"), t("深色外观")],
  ];
  return (
    <div className="nf-seg nf-theme" role="radiogroup" aria-label={t("外观")}>
      {opts.map(([v, label, title]) => (
        <button key={v} role="radio" aria-checked={theme === v} title={title} onClick={() => pick(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Interface language. Each option is labelled in its own language; switching reloads the page. */
export function LangSwitch() {
  const opts: [Lang, string][] = [
    ["zh", "中文"],
    ["en", "English"],
  ];
  return (
    <div className="nf-seg nf-theme" role="radiogroup" aria-label={t("语言")}>
      {opts.map(([v, label]) => (
        <button key={v} role="radio" aria-checked={lang === v} lang={v === "zh" ? "zh-CN" : "en"} onClick={() => v !== lang && setLang(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}
