import { useEffect, useState } from "react";
import { t } from "./i18n.ts";
import { IconChevronDown, IconKeyboard } from "./icons.tsx";

const KEY = "naturoflow.shortcuts";
const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = mac ? "⌘" : "Ctrl";

/** Keys shown as chips; "+" joins keys pressed together, "/" separates alternatives. */
type Row = [keys: string[][], what: string];

function groups(): [string, Row[]][] {
  return [
    [
      t("选择"),
      [
        [[[t("拖动空白处")]], t("框选")],
        [[["Shift", t("点击")], [MOD, t("点击")]], t("加选 / 取消选择")],
        [[[MOD, "A"]], t("全选")],
      ],
    ],
    [
      t("编辑"),
      [
        [[[MOD, "C"]], t("复制")],
        [[[MOD, "X"]], t("剪切")],
        [[[MOD, "V"]], t("粘贴")],
        [[[MOD, "D"]], t("复制一份")],
        [[["Delete"], ["⌫"]], t("删除选中的节点或连线")],
      ],
    ],
    [
      t("画布"),
      [
        [[[t("双指滑动")], [t("空格"), t("拖动")]], t("平移")],
        [[[t("双指捏合")], [MOD, t("滚轮")]], t("缩放")],
        [[[t("从输出拖到输入")]], t("连线")],
        [[[t("把连线端点拖到空白处")]], t("断开连线")],
        [[[t("双击图片")]], t("放大查看")],
      ],
    ],
  ];
}

function read() {
  try {
    return localStorage.getItem(KEY) === "open";
  } catch {
    return false;
  }
}

/** A keyboard guide pinned to the canvas corner; collapses to a small button. "?" toggles it. */
export function Shortcuts() {
  const [open, setOpen] = useState(read);
  const toggle = (v = !open) => {
    setOpen(v);
    try {
      localStorage.setItem(KEY, v ? "open" : "closed");
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const question = e.key === "?" || (e.code === "Slash" && e.shiftKey);
      if (!question || e.metaKey || e.ctrlKey || el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!open) {
    return (
      <button className="nf-keys__toggle" onClick={() => toggle(true)} aria-expanded={false} title={t("快捷键（?）")}>
        <IconKeyboard />
        {t("快捷键")}
      </button>
    );
  }

  return (
    <section className="nf-keys" aria-label={t("快捷键")}>
      <header className="nf-keys__head">
        <IconKeyboard />
        <h2>{t("快捷键")}</h2>
        <button className="nf-keys__close" onClick={() => toggle(false)} aria-expanded={true} title={t("收起（?）")} aria-label={t("收起")}>
          <IconChevronDown />
        </button>
      </header>
      {groups().map(([title, rows]) => (
        <div key={title} className="nf-keys__group">
          <h3>{title}</h3>
          <dl>
            {rows.map(([alts, what]) => (
              <div key={what} className="nf-keys__row">
                <dt>{what}</dt>
                <dd>
                  {alts.map((combo, i) => (
                    <span key={i} className="nf-keys__alt">
                      {i > 0 && <span className="nf-keys__or">{t("或")}</span>}
                      {combo.map((k, j) => (
                        <kbd key={j} data-text={k.length > 6 || /[一-鿿]{3,}/.test(k) || undefined}>
                          {k}
                        </kbd>
                      ))}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </section>
  );
}
