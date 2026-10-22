/** Pick a readable, unique node id from a base name, e.g. "ffmpeg.to-gif" -> "to_gif_2". */
export function freshNodeId(typeId: string, taken: Set<string>) {
  const base = (typeId.split(".").pop() ?? "node").replace(/[^a-zA-Z0-9_]/g, "_") || "node";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}
