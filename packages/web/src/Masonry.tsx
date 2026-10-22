import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/** Grid row unit (px) used by `.nf-masonry`; items span as many rows as their height needs. */
const ROW = 4;

/**
 * One cell of a masonry grid (`<ul className="nf-masonry">`). Items keep reading order left to
 * right — newest first stays top-left — while each takes the height its content (e.g. an image at
 * its natural aspect ratio) needs.
 */
export function MasonryItem({ children, gap, className, style, ...rest }: { children: ReactNode; gap: number; className?: string; style?: CSSProperties } & Record<`data-${string}`, unknown>) {
  const inner = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState(60);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => setSpan(Math.max(1, Math.ceil((el.getBoundingClientRect().height + gap) / ROW)));
    measure();
    // Re-measure as images load or the column width changes.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gap]);

  return (
    <li className={className} style={{ ...style, gridRowEnd: `span ${span}` }} {...rest}>
      <div ref={inner} className="nf-masonry__inner">
        {children}
      </div>
    </li>
  );
}
