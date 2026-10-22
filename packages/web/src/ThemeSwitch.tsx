import { useState } from "react";
import { lang, setLang, t, type Lang } from "./i18n.ts";
import { IconAuto, IconGlobe, IconMoon, IconSun } from "./icons.tsx";
import { Menu } from "./Menu.tsx";

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

const THEME_ICONS = { system: <IconAuto />, light: <IconSun />, dark: <IconMoon /> };

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
  return (
    <Menu
      label={t("外观")}
      trigger={THEME_ICONS[theme]}
      value={theme}
      onSelect={pick}
      options={[
        { value: "system", label: t("跟随系统"), icon: THEME_ICONS.system },
        { value: "light", label: t("浅色"), icon: THEME_ICONS.light },
        { value: "dark", label: t("深色"), icon: THEME_ICONS.dark },
      ]}
    />
  );
}

const LANG_NAMES: Record<Lang, string> = { zh: "中文", en: "English" };

/** Interface language. Each option is labelled in its own language; switching reloads the page. */
export function LangSwitch() {
  return (
    <Menu
      label={t("语言")}
      trigger={
        <>
          <IconGlobe />
          <span className="nf-menu__val">{lang === "zh" ? "中文" : "EN"}</span>
        </>
      }
      value={lang}
      onSelect={setLang}
      options={(Object.keys(LANG_NAMES) as Lang[]).map((v) => ({ value: v, label: LANG_NAMES[v], lang: v === "zh" ? "zh-CN" : "en" }))}
    />
  );
}
