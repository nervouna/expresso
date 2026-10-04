export interface CompactOptions {
  nerdFonts: boolean;
  footer?: boolean;
  timing?: "group" | "response";
}

export function readOptions(settings: unknown): CompactOptions {
  const expresso = settings && typeof settings === "object"
    ? (settings as Record<string, unknown>).expresso : undefined;
  return {
    footer: !!expresso && typeof expresso === "object" && !Array.isArray(expresso) &&
      (expresso as Record<string, unknown>).footer === true,
    timing: expresso && typeof expresso === "object" && !Array.isArray(expresso) &&
      (expresso as Record<string, unknown>).timing === "response" ? "response" : "group",
    nerdFonts: !!expresso && typeof expresso === "object" && !Array.isArray(expresso) &&
      (expresso as Record<string, unknown>).nerdFonts === true,
  };
}
