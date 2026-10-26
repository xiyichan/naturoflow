import type { ReactNode } from "react";

/**
 * The one way to show "nothing here yet" (like SwiftUI's ContentUnavailableView): an icon,
 * a title, a line on what to do, and optionally the action that fixes it.
 */
export function Empty({
  icon,
  title,
  children,
  action,
  compact,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  /** Inside a panel section rather than filling an area. */
  compact?: boolean;
}) {
  return (
    <div className="nf-unavail" data-compact={compact || undefined} role="status">
      <span className="nf-unavail__icon" aria-hidden="true">
        {icon}
      </span>
      <p className="nf-unavail__title">{title}</p>
      {children && <p className="nf-unavail__desc">{children}</p>}
      {action && <div className="nf-unavail__action">{action}</div>}
    </div>
  );
}
