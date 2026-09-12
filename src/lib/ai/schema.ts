import { z, type ZodTypeAny } from "zod";

/**
 * Minimal Zod -> JSON Schema converter.
 *
 * Structured prompts need two artefacts that must never drift: a JSON Schema
 * for the model and a Zod schema for validation. Deriving one from the other
 * keeps them in lockstep. Only the subset of Zod the prompts actually use is
 * supported — anything else throws loudly at module load rather than silently
 * producing a schema the model cannot satisfy.
 *
 * Output targets strict tool use, so every object gets
 * `additionalProperties: false` and an explicit `required` list.
 */
export function toJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const node = convert(schema);
  return node;
}

function unwrapDescription(schema: ZodTypeAny): string | undefined {
  return schema.description;
}

function convert(schema: ZodTypeAny): Record<string, unknown> {
  const description = unwrapDescription(schema);
  const base = convertInner(schema);
  return description ? { ...base, description } : base;
}

function convertInner(schema: ZodTypeAny): Record<string, unknown> {
  const def = schema._def as unknown as { typeName: string } & Record<string, any>;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const checks = (def.checks ?? []) as { kind: string; value?: number }[];
      const node: Record<string, unknown> = { type: "string" };
      for (const check of checks) {
        if (check.kind === "min") node.minLength = check.value;
        if (check.kind === "max") node.maxLength = check.value;
      }
      return node;
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const checks = (def.checks ?? []) as { kind: string; value?: number }[];
      const isInt = checks.some((c) => c.kind === "int");
      const node: Record<string, unknown> = { type: isInt ? "integer" : "number" };
      for (const check of checks) {
        if (check.kind === "min") node.minimum = check.value;
        if (check.kind === "max") node.maximum = check.value;
      }
      return node;
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return { type: "boolean" };
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return { const: (def as any).value };
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return { type: "string", enum: (def as any).values };
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const inner = (def as any).type;
      const constraints = def as { minLength?: { value: number }; maxLength?: { value: number } };
      const node: Record<string, unknown> = { type: "array", items: convert(inner) };
      if (constraints.minLength) node.minItems = constraints.minLength.value;
      if (constraints.maxLength) node.maxItems = constraints.maxLength.value;
      return node;
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const field = value as ZodTypeAny;
        properties[key] = convert(field);
        // Strict tool use requires every property listed. Optional fields are
        // expressed as nullable-and-required so the model must be explicit.
        required.push(key);
      }
      return {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      };
    }
    case z.ZodFirstPartyTypeKind.ZodNullable: {
      const inner = convert((def as any).innerType);
      const type = inner.type;
      if (typeof type === "string") return { ...inner, type: [type, "null"] };
      return { anyOf: [inner, { type: "null" }] };
    }
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return convert((def as any).innerType);
    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const options = (def as any).options;
      return { anyOf: options.map(convert) };
    }
    default:
      throw new Error(
        `toJsonSchema: unsupported Zod type "${def.typeName}". Add a case or simplify the schema.`,
      );
  }
}
