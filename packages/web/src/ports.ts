import { t } from "./i18n.ts";
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
  file: t("文件"),
  json: "JSON",
  string: t("文本"),
  number: t("数字"),
  boolean: t("布尔"),
  any: t("任意"),
};

export function typeLabel(type: string): string {
  if (type.startsWith("list<")) return t("{0} 列表", [TYPE_LABELS[type.slice(5, -1)] ?? type.slice(5, -1)]);
  return TYPE_LABELS[type] ?? type;
}

export const EXECUTOR_LABELS: Record<string, string> = {
  http: "HTTP",
  command: t("命令"),
  script: t("脚本"),
  builtin: t("内置"),
};
