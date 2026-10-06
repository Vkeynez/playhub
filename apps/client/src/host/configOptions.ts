// Turns a game's zod configSchema into pickable options for the pre-game sheet, through zod's
// JSON Schema export (public API, no zod internals): literal unions / enums become choice chips,
// bounded numbers get a few presets, optional fields without a default get a "Default" chip.
import { z } from 'zod';

export type OptionValue = string | number | boolean;

export interface ConfigOption {
  key: string;
  /** `undefined` = leave the field out (the game's default applies). */
  choices: (OptionValue | undefined)[];
  initial: OptionValue | undefined;
}

interface JsonSchemaNode {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

const NUMBER_PRESETS = [5, 10, 30, 60];

function isOptionValue(v: unknown): v is OptionValue {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function choicesOf(node: JsonSchemaNode): OptionValue[] {
  if (node.enum) return node.enum.filter(isOptionValue);
  const alternatives = node.anyOf ?? node.oneOf;
  if (alternatives?.every((alt) => isOptionValue(alt.const))) {
    return alternatives.map((alt) => alt.const as OptionValue);
  }
  if (isOptionValue(node.const)) return [node.const];
  if (node.type === 'boolean') return [false, true];
  if (node.type === 'integer' || node.type === 'number') {
    const min = node.minimum ?? -Infinity;
    const max = node.maximum ?? Infinity;
    return NUMBER_PRESETS.filter((n) => n >= min && n <= max);
  }
  return [];
}

export function configOptions(schema: z.ZodType): ConfigOption[] {
  let root: JsonSchemaNode;
  try {
    root = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchemaNode;
  } catch {
    return [];
  }
  const required = new Set(root.required ?? []);
  return Object.entries(root.properties ?? {}).flatMap(([key, node]) => {
    const choices = choicesOf(node);
    if (choices.length === 0) return [];
    const initial = isOptionValue(node.default) ? node.default : undefined;
    const optional = !required.has(key) && initial === undefined;
    return [
      {
        key,
        choices: optional ? [undefined, ...choices] : choices,
        initial: initial ?? (optional ? undefined : choices[0]),
      },
    ];
  });
}

export function initialConfig(options: readonly ConfigOption[]): Record<string, OptionValue> {
  const config: Record<string, OptionValue> = {};
  for (const option of options)
    if (option.initial !== undefined) config[option.key] = option.initial;
  return config;
}
