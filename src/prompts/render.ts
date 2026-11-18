import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PROMPTS_DIR = resolve(import.meta.dirname, "..", "..", "prompts");

const cache = new Map<string, string>();

function load(name: string): string {
  let t = cache.get(name);
  if (t === undefined) {
    t = readFileSync(resolve(PROMPTS_DIR, `${name}.md`), "utf8");
    cache.set(name, t);
  }
  return t;
}

/**
 * Render `prompts/<name>.md`, replacing `{{key}}` placeholders.
 * Every placeholder must be provided and every provided key must be used,
 * so a typo can never silently ship an empty section to a model.
 * `{{> partial}}` includes `prompts/<partial>.md`.
 */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  const withPartials = load(name).replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, p: string) => load(p));
  const used = new Set<string>();
  const out = withPartials.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`prompt "${name}": missing value for {{${key}}}`);
    used.add(key);
    return vars[key]!;
  });
  const unused = Object.keys(vars).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`prompt "${name}": unused values ${unused.join(", ")}`);
  return out;
}

/** Markdown bullet list, or a placeholder when empty. */
export const bullets = (items: readonly string[], empty = "_(none)_") =>
  items.length ? items.map((i) => `- ${i}`).join("\n") : empty;
