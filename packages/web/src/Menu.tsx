import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconCheck, IconChevronDown } from "./icons.tsx";

export interface MenuOption<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  /** Shown in the option's own language, e.g. "English" in a Chinese UI. */
  lang?: string;
}

/**
 * A toolbar button that opens a small single-choice menu (macOS pop-up style): click or
 * arrow keys to move, Enter to pick, Escape or a click outside to close.
 */
export function Menu<V extends string>({
  label,
  trigger,
  options,
  value,
  onSelect,
}: {
  /** Accessible name of the button and menu. */
  label: string;
  trigger: ReactNode;
  options: MenuOption<V>[];
  value: V;
  onSelect: (v: V) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    // Focus the checked option so arrow keys start from it.
    items.current[Math.max(0, options.findIndex((o) => o.value === value))]?.focus();
    return () => document.removeEventListener("pointerdown", away);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const i = items.current.indexOf(document.activeElement as HTMLButtonElement);
    const move = (d: number) => items.current[(i + d + options.length) % options.length]?.focus();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Home") items.current[0]?.focus();
    else if (e.key === "End") items.current[options.length - 1]?.focus();
    else if (e.key === "Tab") setOpen(false);
    else return;
    e.preventDefault();
  };

  return (
    <div className="nf-menu" ref={wrap}>
      <button
        ref={button}
        className="nf-menu__btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {trigger}
        <IconChevronDown className="nf-menu__chev" />
      </button>
      {open && (
        <div className="nf-menu__pop" role="menu" id={id} aria-label={label} onKeyDown={onKey}>
          {options.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="menuitemradio"
              aria-checked={o.value === value}
              lang={o.lang}
              onClick={() => {
                close();
                if (o.value !== value) onSelect(o.value);
              }}
            >
              <span className="nf-menu__check">{o.value === value && <IconCheck width={13} height={13} />}</span>
              {o.icon && <span className="nf-menu__icon">{o.icon}</span>}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
