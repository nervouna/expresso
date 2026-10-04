export interface CompactOptions {
  nerdFonts: boolean;
}

export function readOptions(settings: unknown): CompactOptions {
  const expresso = settings && typeof settings === "object"
    ? (settings as Record<string, unknown>).expresso : undefined;
  return {
    nerdFonts: !!expresso && typeof expresso === "object" && !Array.isArray(expresso) &&
      (expresso as Record<string, unknown>).nerdFonts === true,
  };
}
