// MCP `elicitation/create` requests reach Integrated agents through Codex
// (mcpServer/elicitation/request) and Claude (control_request elicitation).
// Both carry the MCP form schema, a flat object of primitive properties, or a
// URL to open. This projects either into the shared form request the composer
// dock already renders, so a paused MCP tool is answerable instead of hanging.

type JsonRecord = Record<string, unknown>;

export interface ElicitationFormField {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
  title?: string;
  description?: string;
  required: boolean;
  options: Array<{ value: string; label: string }>;
  custom: boolean;
  format?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  when: [];
  url?: string;
}

export interface ElicitationForm {
  id: string;
  title: string;
  detail?: string;
  // Elicitations can be declined; the dock offers Decline alongside Submit.
  declinable: true;
  fields: ElicitationFormField[];
}

export interface ElicitationRequest {
  id: string;
  message: string;
  // A short permission-display heading; the message then becomes detail.
  title?: string | undefined;
  source?: string | undefined;
  mode?: string | undefined;
  schema?: unknown;
  url?: string | undefined;
}

// Unsupported property shapes are dropped. A form whose every property was
// dropped still renders with its message, so it can be declined.
export function elicitationForm(request: ElicitationRequest): ElicitationForm {
  const heading = request.title?.trim() ? request.title.trim() : '';
  const detail = [heading ? request.message : '', request.source ? `Requested by ${request.source}` : ''].filter(Boolean).join('\n') || undefined;
  if (heading) request = { ...request, message: heading };
  if (request.mode === 'url' || (request.url && !request.schema)) {
    return {
      id: request.id,
      title: request.message || 'Open the link to continue',
      ...(detail ? { detail } : {}),
      declinable: true,
      fields: request.url ? [{ key: 'url', type: 'external', title: 'Link', required: false, options: [], custom: false, when: [], url: request.url }] : []
    };
  }
  const schema = record(request.schema);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  const properties = record(schema.properties);
  const fields = Object.entries(properties).flatMap(([key, value]) => {
    const field = elicitationField(key, record(value), required.has(key));
    return field ? [field] : [];
  });
  return { id: request.id, title: request.message || 'Input requested', ...(detail ? { detail } : {}), declinable: true, fields };
}

function elicitationField(key: string, property: JsonRecord, required: boolean): ElicitationFormField | null {
  const base = {
    key,
    required,
    custom: false,
    when: [] as [],
    ...(typeof property.title === 'string' && property.title ? { title: property.title } : {}),
    ...(typeof property.description === 'string' && property.description ? { description: property.description } : {}),
    ...(property.default !== undefined ? { default: property.default } : {})
  };
  const type = property.type;
  if (type === 'boolean') return { ...base, type: 'boolean', options: [] };
  if (type === 'number' || type === 'integer') {
    return {
      ...base,
      type,
      options: [],
      ...(finite(property.minimum) !== undefined ? { minimum: finite(property.minimum)! } : {}),
      ...(finite(property.maximum) !== undefined ? { maximum: finite(property.maximum)! } : {})
    };
  }
  if (type === 'array') {
    const items = record(property.items);
    const options = enumOptions(items.enum, undefined, items.anyOf ?? items.oneOf);
    if (!options.length) return null;
    return {
      ...base,
      type: 'multiselect',
      options,
      ...(finite(property.minItems) !== undefined ? { minItems: finite(property.minItems)! } : {}),
      ...(finite(property.maxItems) !== undefined ? { maxItems: finite(property.maxItems)! } : {})
    };
  }
  if (type === 'string' || type === undefined) {
    const options = enumOptions(property.enum, property.enumNames, property.oneOf ?? property.anyOf);
    return {
      ...base,
      type: 'string',
      options,
      ...(typeof property.format === 'string' ? { format: property.format } : {})
    };
  }
  return null;
}

function enumOptions(values: unknown, names: unknown, titled: unknown): Array<{ value: string; label: string }> {
  if (Array.isArray(titled)) {
    return titled.flatMap((option) => {
      const entry = record(option);
      return typeof entry.const === 'string' ? [{ value: entry.const, label: typeof entry.title === 'string' ? entry.title : entry.const }] : [];
    });
  }
  if (!Array.isArray(values)) return [];
  const labels = Array.isArray(names) ? names : [];
  return values.flatMap((value, index) => typeof value === 'string'
    ? [{ value, label: typeof labels[index] === 'string' ? labels[index] as string : value }]
    : []);
}

// MCP answers must match the schema's own types. The dock already produces
// native values; integers are re-checked because the editor accepts any number.
export function elicitationContent(form: ElicitationForm, answer: JsonRecord): JsonRecord | null {
  const content: JsonRecord = {};
  for (const field of form.fields) {
    if (field.type === 'external') continue;
    const value = answer[field.key];
    if (value === undefined) {
      if (field.required) throw new Error(`Answer "${field.title ?? field.key}" before submitting`);
      continue;
    }
    if (field.type === 'integer' && !Number.isInteger(value)) throw new Error(`"${field.title ?? field.key}" must be a whole number`);
    content[field.key] = value;
  }
  // URL elicitations carry no content on accept.
  return form.fields.some((field) => field.type !== 'external') ? content : null;
}

function finite(value: unknown): number | undefined {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
