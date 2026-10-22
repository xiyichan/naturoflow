// Browser-safe: shared by the engine and the canvas UI's connection checks.

/** Can a value of type `from` flow into a port of type `to`? */
export function portCompatible(from: string, to: string): boolean {
  if (from === "any" || to === "any" || from === to) return true;
  if (to === "json" && from !== "file" && !from.startsWith("list<file")) return true;
  if (to === "string" && (from === "number" || from === "boolean")) return true;
  if (to.startsWith("list<") && from.startsWith("list<")) return portCompatible(from.slice(5, -1), to.slice(5, -1));
  return false;
}
