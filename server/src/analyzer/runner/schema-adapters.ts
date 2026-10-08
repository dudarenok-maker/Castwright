/* Per-provider structured-output schema adapters (#3084 decision 2, spec §2).

   Input: the draft-07 schema the runner builds with
   z.toJSONSchema(grammarSchema, { target: 'draft-07', reused: 'inline' }).
   Output: that schema rewritten into the subset the provider documents, plus
   `dropped` — the path of every constraint that could not be carried. Our Zod
   validator still enforces the FULL schema on every reply; `dropped` exists so
   the label never claims more than the wire carried ("schema (partial)").

   `$schema` is removed for Gemini and OpenAI but never recorded: it is a
   dialect marker, not a constraint, and recording it would label every
   endpoint "partial". */

import type { StructuredOutputMode, StructuredOutputRequest } from './transport.js';
import type { ModelCapabilityRecord } from '../capabilities.js';

export interface AdaptedSchema {
  schema: Record<string, unknown>;
  dropped: string[];
}

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/* Keywords whose value is a map of NAME → subschema (the names are data, not keywords). */
const SCHEMA_MAP = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
/* Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
/* Keywords whose value is a single subschema (or, for items, possibly an array). */
const SCHEMA_SINGLE = new Set(['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains', 'propertyNames']);

interface Rules {
  keep: (keyword: string) => boolean;
  normalize?: (node: Node) => Node;
}

function adaptNode(node: Node, path: string, dropped: Set<string>, rules: Rules): Node {
  const source = rules.normalize ? rules.normalize(node) : node;
  const out: Node = {};
  for (const [key, value] of Object.entries(source)) {
    const here = path ? `${path}.${key}` : key;
    if (key === '$schema') continue;
    if (!rules.keep(key)) {
      dropped.add(here);
      continue;
    }
    if (SCHEMA_MAP.has(key) && isNode(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [
          name,
          isNode(sub) ? adaptNode(sub, `${here}.${name}`, dropped, rules) : sub,
        ]),
      );
    } else if ((SCHEMA_ARRAY.has(key) || key === 'items') && Array.isArray(value)) {
      out[key] = value.map((sub, i) => (isNode(sub) ? adaptNode(sub, `${here}[${i}]`, dropped, rules) : sub));
    } else if (SCHEMA_SINGLE.has(key) && isNode(value)) {
      out[key] = adaptNode(value, here, dropped, rules);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function run(schema: Node, rules: Rules): AdaptedSchema {
  const dropped = new Set<string>();
  const adapted = adaptNode(schema, '', dropped, rules);
  return { schema: adapted, dropped: [...dropped].sort() };
}

/* Keywords Gemini's `responseJsonSchema` documents (@google/genai 2.19
   genai.d.ts, the `responseJsonSchema` doc comment). */
const GEMINI_KEYWORDS = new Set([
  '$id', '$defs', '$ref', '$anchor', 'type', 'format', 'title', 'description', 'enum',
  'items', 'prefixItems', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'oneOf',
  'properties', 'additionalProperties', 'required', 'propertyOrdering',
]);

const isIntegerType = (t: unknown): boolean =>
  t === 'integer' || (Array.isArray(t) && t.includes('integer'));

/** For integers, x > n ⇔ x ≥ floor(n) + 1, so exclusiveMinimum is carried losslessly. */
function geminiNormalize(node: Node): Node {
  if (typeof node.exclusiveMinimum !== 'number' || !isIntegerType(node.type)) return node;
  const { exclusiveMinimum, ...rest } = node;
  const floor = Math.floor(exclusiveMinimum as number) + 1;
  rest.minimum = typeof rest.minimum === 'number' ? Math.max(rest.minimum, floor) : floor;
  return rest;
}

export function adaptSchemaForOllama(s: Record<string, unknown>): AdaptedSchema {
  return { schema: s, dropped: [] };
}

export function adaptSchemaForGemini(s: Record<string, unknown>): AdaptedSchema {
  return run(s, { keep: (k) => GEMINI_KEYWORDS.has(k), normalize: geminiNormalize });
}

export function adaptSchemaForOpenAI(s: Record<string, unknown>): AdaptedSchema {
  return run(s, { keep: () => true });
}

/** OpenAI requires json_schema.name to match ^[a-zA-Z0-9_-]{1,64}$. */
export function structuredOutputSchemaName(key: string): string {
  return `castwright_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

/** The runner's one place that turns a configured mode into the wire request. */
export function buildStructuredOutputRequest(
  mode: StructuredOutputMode,
  name: string,
  draft07: Record<string, unknown>,
  adapt: (s: Record<string, unknown>) => AdaptedSchema,
): { request: StructuredOutputRequest; dropped: string[] } {
  if (mode === 'json') return { request: { mode: 'json' }, dropped: [] };
  if (mode === 'off') return { request: { mode: 'off' }, dropped: [] };
  const { schema, dropped } = adapt(draft07);
  return { request: { mode: 'schema', name, schema }, dropped };
}

/** "schema" | "schema (partial)" | "schema (not enforced)" | "json" | "off" —
    only what was observed. `reasoningKey` is the configured reasoning level, or
    'configured' before wave 5. */
export function structuredOutputLabel(
  mode: StructuredOutputMode,
  dropped: string[],
  record: ModelCapabilityRecord | undefined,
  reasoningKey: string,
): string {
  if (mode !== 'schema') return mode;
  if (record?.structuredOutput.schema?.[reasoningKey] === 'ignored') return 'schema (not enforced)';
  return dropped.length > 0 ? 'schema (partial)' : 'schema';
}
