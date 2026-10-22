export { portCompatible } from "../../core/src/ports.ts";

/** Each data type has its own cable color; this is the canvas's main visual language. */
const COLORS: Record<string, string> = {
  file: "var(--t-file)",
  json: "var(--t-json)",
  string: "var(--t-string)",
  number: "var(--t-number)",
  boolean: "var(--t-boolean)",
  any: "var(--t-any)",
};

export function typeColor(type: string | undefined): string {
  if (!type) return COLORS.any;
  const base = type.startsWith("list<") ? type.slice(5, -1) : type;
  return COLORS[base] ?? COLORS.any;
}

export const TYPE_LABELS: Record<string, string> = {
  file: "文件",
  json: "JSON",
  string: "文本",
  number: "数字",
  boolean: "布尔",
  any: "任意",
};

export function typeLabel(type: string): string {
  if (type.startsWith("list<")) return `${TYPE_LABELS[type.slice(5, -1)] ?? type.slice(5, -1)} 列表`;
  return TYPE_LABELS[type] ?? type;
}

export const EXECUTOR_LABELS: Record<string, string> = {
  http: "HTTP",
  command: "命令",
  script: "脚本",
  builtin: "内置",
};
