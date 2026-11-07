import { canonical, manifest, ValidationError, type Json } from "../registry/validation.js";

/** Validate against the exact bounded schema dialect accepted at publication. */
export function validateArguments(schema: unknown, raw: unknown): Json {
  manifest({ tools: [{ name: "validation", revision: 1, description: "schema validation", inputSchema: schema,
    declaredProfile: "READ_ONLY", handlerId: "validation" }] });
  const normalized = canonical(raw).value;
  function walk(s: any, value: Json): void {
    if (s.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Expected object argument");
      const obj = value as Record<string, Json>;
      for (const name of s.required ?? []) if (!Object.hasOwn(obj, name)) throw new ValidationError("Missing required argument");
      for (const [name, v] of Object.entries(obj)) {
        if (!Object.hasOwn(s.properties, name)) throw new ValidationError("Unexpected argument");
        if (/^(password|secret|token|api[_-]?key|authorization|credential)$/i.test(name)) throw new ValidationError("Credential fields are not accepted");
        walk(s.properties[name], v);
      }
    } else if (s.type === "array") {
      if (!Array.isArray(value)) throw new ValidationError("Expected array argument");
      for (const v of value) walk(s.items, v);
    } else if (s.type === "null") {
      if (value !== null) throw new ValidationError("Expected null argument");
    } else if (s.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ValidationError("Expected integer argument");
    } else if (typeof value !== s.type) throw new ValidationError("Argument type mismatch");
    if (typeof value === "string" && /^af_[A-Za-z0-9_-]{43}$/.test(value)) throw new ValidationError("Credentials are not accepted as arguments");
  }
  walk(schema, normalized);
  return normalized;
}
