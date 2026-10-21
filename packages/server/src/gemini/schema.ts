/**
 * Gemini takes a subset of JSON Schema (an OpenAPI schema) and refuses the
 * rest, so what zod generates is rewritten to what it accepts. One source of
 * truth for the shapes (the contract and the tools), one place that knows
 * about Gemini.
 */

type Json = Record<string, any>;

/** Anything else is dropped. */
const COPIED = ['description', 'enum', 'minItems', 'maxItems', 'minLength', 'maxLength'];
const SAFE_NUMBER = 1_000_000_000;

export function toGeminiSchema(input: unknown): Json {
  const schema = (input ?? {}) as Json;
  const out: Json = {};
  let type = schema.type;
  let nullable = schema.nullable === true;

  /**
   * "string or null" is anyOf [string, null] in JSON Schema, nullable in Gemini.
   */
  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.filter((variant: Json) => !(variant && variant.type === 'null'));

    nullable = nullable || variants.length !== schema.anyOf.length;

    if (variants.length === 1) {
      return {
        ...toGeminiSchema(variants[0]),
        ...(schema.description ? { description: schema.description } : {}),
        ...(nullable ? { nullable: true } : {})
      };
    }

    out.anyOf = variants.map(toGeminiSchema);
  }

  if (Array.isArray(type)) {
    const concrete = type.filter((candidate: string) => candidate !== 'null');

    nullable = nullable || concrete.length !== type.length;
    type = concrete[0];
  }

  if ('const' in schema) {
    out.enum = [schema.const];
    type = type ?? typeof schema.const;
  }

  if (typeof type === 'string') {
    out.type = type.toUpperCase();
  }

  COPIED.forEach(key => {
    if (schema[key] !== undefined) out[key] = schema[key];
  });

  ['minimum', 'maximum'].forEach(key => {
    if (typeof schema[key] === 'number' && Math.abs(schema[key]) <= SAFE_NUMBER) out[key] = schema[key];
  });

  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    Object.keys(schema.properties).forEach(name => {
      out.properties[name] = toGeminiSchema(schema.properties[name]);
    });

    const required = (schema.required ?? []).filter((name: string) => name in schema.properties);

    if (required.length > 0) out.required = required;
  }

  /**
   * A tuple (prefixItems) is a list of fixed length: Gemini only has a list
   * with min and max.
   */
  if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
    out.items = toGeminiSchema(schema.prefixItems[0]);
  } else if (schema.items && typeof schema.items === 'object') {
    out.items = toGeminiSchema(schema.items);
  }

  if (nullable) out.nullable = true;

  return out;
}

/**
 * Parameters of a function declaration. Gemini refuses an object with no
 * properties, so a tool without arguments has none.
 */
export function toGeminiParameters(schema: unknown): Json | undefined {
  const converted = toGeminiSchema(schema);

  return converted.properties && Object.keys(converted.properties).length > 0 ? converted : undefined;
}
