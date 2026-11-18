import type { z } from "zod";

export const JSON_OPEN = "<<<JSON";
export const JSON_CLOSE = "JSON>>>";

export type Extracted<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Pull the last `<<<JSON … JSON>>>` block out of a model's answer and validate
 * it. Tolerates a ```json fence inside the markers.
 */
export function extractJson<S extends z.ZodType>(text: string | null | undefined, schema: S): Extracted<z.infer<S>> {
  if (!text) return { ok: false, error: "empty answer" };
  const end = text.lastIndexOf(JSON_CLOSE);
  const start = end >= 0 ? text.lastIndexOf(JSON_OPEN, end) : -1;
  if (start < 0 || end < 0) return { ok: false, error: `no ${JSON_OPEN} … ${JSON_CLOSE} block found at the end of the answer` };

  let body = text.slice(start + JSON_OPEN.length, end).trim();
  body = body.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `JSON does not parse: ${(e as Error).message}` };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return { ok: false, error: `JSON does not match the schema:\n${issues.join("\n")}` };
  }
  return { ok: true, value: r.data };
}
