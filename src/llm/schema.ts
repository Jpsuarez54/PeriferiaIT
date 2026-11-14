// Convierte los esquemas zod de las herramientas a JSON Schema para el modelo.
// Los campos z.record (el `contrato` completo) se ocultan a propósito: el modelo
// no transporta valores del contrato, solo identificadores y confirmaciones (CA2).
import { z } from "zod";
import type { JsonSchema } from "./adapter";

function unwrap(s: z.ZodTypeAny): { inner: z.ZodTypeAny; optional: boolean } {
  let inner = s;
  let optional = false;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
      optional = true;
      inner = inner.unwrap();
    } else if (inner instanceof z.ZodEffects) {
      inner = inner.innerType();
    } else if (inner instanceof z.ZodDefault) {
      optional = true;
      inner = inner.removeDefault();
    } else break;
  }
  return { inner, optional };
}

export function toJsonSchema(schema: z.ZodTypeAny): JsonSchema | null {
  const { inner } = unwrap(schema);
  const description = schema.description ?? inner.description;
  const base = description ? { description } : {};
  if (inner instanceof z.ZodString) return { type: "string", ...base };
  if (inner instanceof z.ZodNumber) return { type: "number", ...base };
  if (inner instanceof z.ZodBoolean) return { type: "boolean", ...base };
  if (inner instanceof z.ZodEnum) return { type: "string", enum: [...(inner.options as string[])], ...base };
  if (inner instanceof z.ZodObject) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
      const js = toJsonSchema(value);
      if (!js) continue;
      properties[key] = js;
      if (!unwrap(value).optional) required.push(key);
    }
    return { type: "object", properties, ...(required.length ? { required } : {}), ...base };
  }
  return null; // z.record / z.unknown: no se expone al modelo
}
