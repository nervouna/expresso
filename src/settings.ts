export interface CompactOptions {
  nerdFonts: boolean;
  timing?: "group" | "response";
}

export function readOptions(settings: unknown): CompactOptions {
  const expresso = settings && typeof settings === "object"
    ? (settings as Record<string, unknown>).expresso : undefined;
  return {
    timing: expresso && typeof expresso === "object" && !Array.isArray(expresso) &&
      (expresso as Record<string, unknown>).timing === "response" ? "response" : "group",
    nerdFonts: !!expresso && typeof expresso === "object" && !Array.isArray(expresso) &&
      (expresso as Record<string, unknown>).nerdFonts === true,
  };
}
