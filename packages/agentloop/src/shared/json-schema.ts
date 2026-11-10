/**
 * Keep the complete non-null schema in its own branch. Some strict tool
 * compilers accept primitive type arrays but reject object/array type arrays.
 * Construct this at the definition site rather than rewriting arbitrary tool
 * schemas, whose references and annotation values must keep their meaning.
 */
export function nullableJsonSchema<const Schema extends Readonly<Record<string, unknown>>>(schema: Schema) {
  return { anyOf: [schema, { type: "null" }] } as const;
}
