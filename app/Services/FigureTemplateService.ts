import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { DatabaseService } from './DatabaseService';
import { figureImagePaths, figureTemplateName, figureVideoPaths, MAX_FIGURE_DATA_CHARS, MAX_FIGURE_HTML_CHARS } from './HtmlFigure';

// Saved html_render templates, shared by the workspace. A template is an HTML
// page, a JSON Schema for the data it draws, and an example of that data. An
// agent publishes versions; each is written once and never changed, so a
// figure that names a version draws the same page for good. Who published a
// version is Patterm's record of the caller, shown to the user in Settings.

export const MAX_TEMPLATE_SCHEMA_CHARS = 64_000;
const MAX_ERRORS = 8;

const jsonObject = z.record(z.unknown());

export const templatePublishInput = z.object({
  name: figureTemplateName,
  description: z.string().trim().max(500).default(''),
  html: z.string().min(1, 'send the page as html').max(MAX_FIGURE_HTML_CHARS, `keep the page under ${MAX_FIGURE_HTML_CHARS} characters`),
  schema: jsonObject,
  example: z.unknown()
}).strict();
export type TemplatePublishInput = z.input<typeof templatePublishInput>;

export const templateGetInput = z.object({
  name: figureTemplateName,
  version: z.number().int().min(1).optional()
}).strict();

export interface TemplatePublisher {
  role: string;
  name: string | null;
  session_id: string | null;
}

export interface TemplateVersion {
  name: string;
  version: number;
  description: string;
  sha256: string;
  published_by: { role: string; name: string | null };
  published_at: string;
}

interface Row {
  name: string;
  version: number;
  description: string;
  html: string;
  schema_json: string;
  example_json: string;
  sha256: string;
  published_by_role: string;
  published_by_name: string | null;
  published_by_session_id: string | null;
  published_at: string;
}

export type TemplateCheck =
  | { ok: true; name: string; version: number }
  | { ok: false; errors: string[] };

export class FigureTemplateService {
  // Versions never change, so each compiled schema stays good.
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(private readonly database: DatabaseService, private readonly now = () => new Date()) {}

  // A new version, unless it matches the latest one exactly, which is
  // returned instead so republishing the same files is harmless.
  publish(raw: unknown, publisher: TemplatePublisher): TemplateVersion & { unchanged: boolean } {
    const input = templatePublishInput.parse(raw);
    const errors: string[] = [];
    const local = [...figureImagePaths(input.html), ...figureVideoPaths(input.html)];
    if (local.length) errors.push(`html: templates cannot show local files (${local.slice(0, 3).map((file) => `"${file}"`).join(', ')}); use data: or https URLs`);
    const schemaJson = JSON.stringify(input.schema);
    if (schemaJson.length > MAX_TEMPLATE_SCHEMA_CHARS) errors.push(`schema: keep it under ${MAX_TEMPLATE_SCHEMA_CHARS} characters`);
    const exampleJson = input.example === undefined ? undefined : JSON.stringify(input.example);
    if (exampleJson === undefined) errors.push('example: send an example of the data');
    else if (exampleJson.length > MAX_FIGURE_DATA_CHARS) errors.push(`example: keep it under ${MAX_FIGURE_DATA_CHARS} characters`);
    let validate: ValidateFunction | null = null;
    if (!errors.length) {
      try { validate = compile(input.schema); } catch (error) { errors.push(`schema: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (validate && !validate(input.example)) errors.push(...formatSchemaErrors(validate.errors ?? []).map((error) => `example: ${error}`));
    if (errors.length) throw new Error(`template_publish: nothing was published. Fix these and call again:\n${errors.map((error) => `- ${error}`).join('\n')}`);

    const sha256 = createHash('sha256').update(JSON.stringify([input.description, input.html, schemaJson, exampleJson])).digest('hex');
    const connection = this.database.connection;
    const latest = this.row(input.name);
    if (latest?.sha256 === sha256) return { ...version(latest), unchanged: true };
    const row: Row = {
      name: input.name,
      version: (latest?.version ?? 0) + 1,
      description: input.description,
      html: input.html,
      schema_json: schemaJson,
      example_json: exampleJson!,
      sha256,
      published_by_role: publisher.role,
      published_by_name: publisher.name,
      published_by_session_id: publisher.session_id,
      published_at: this.now().toISOString()
    };
    connection.prepare(`insert into figure_templates(name, version, description, html, schema_json, example_json, sha256, published_by_role, published_by_name, published_by_session_id, published_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.name, row.version, row.description, row.html, row.schema_json, row.example_json, row.sha256, row.published_by_role, row.published_by_name, row.published_by_session_id, row.published_at);
    return { ...version(row), unchanged: false };
  }

  // Each template's latest version, by name.
  list(): Array<TemplateVersion & { versions: number }> {
    const rows = this.database.connection.prepare(`select t.*, (select count(*) from figure_templates c where c.name = t.name) as versions
      from figure_templates t
      where t.version = (select max(version) from figure_templates m where m.name = t.name)
      order by t.name`).all() as unknown as Array<Row & { versions: number }>;
    return rows.map((row) => ({ ...version(row), versions: row.versions }));
  }

  // Every version, newest first within each name, for Settings.
  history(): TemplateVersion[] {
    const rows = this.database.connection.prepare('select * from figure_templates order by name, version desc').all() as unknown as Row[];
    return rows.map(version);
  }

  // What an agent needs to fill a template: its schema and example, not its page.
  get(raw: unknown): TemplateVersion & { schema: unknown; example: unknown } {
    const input = templateGetInput.parse(raw);
    const row = this.row(input.name, input.version);
    if (!row) throw new Error(missing(input.name, input.version));
    return { ...version(row), schema: JSON.parse(row.schema_json), example: JSON.parse(row.example_json) };
  }

  // The page a figure draws. Only Patterm's renderer reads it.
  page(name: string, versionNumber: number): { html: string; sha256: string } | null {
    const row = this.row(name, versionNumber);
    return row ? { html: row.html, sha256: row.sha256 } : null;
  }

  // Checks data against a version's schema: the one named, else the latest.
  check(name: string, versionNumber: number | undefined, data: unknown): TemplateCheck {
    const row = this.row(name, versionNumber);
    if (!row) return { ok: false, errors: [missing(name, versionNumber)] };
    const serialised = JSON.stringify(data);
    if (serialised === undefined) return { ok: false, errors: ['data: send the data the template draws'] };
    if (serialised.length > MAX_FIGURE_DATA_CHARS) return { ok: false, errors: [`data: keep it under ${MAX_FIGURE_DATA_CHARS} characters`] };
    const key = `${row.name}@${row.version}`;
    let validate = this.validators.get(key);
    if (!validate) {
      validate = compile(JSON.parse(row.schema_json) as Record<string, unknown>);
      this.validators.set(key, validate);
    }
    return validate(data) ? { ok: true, name: row.name, version: row.version } : { ok: false, errors: formatSchemaErrors(validate.errors ?? []) };
  }

  private row(name: string, versionNumber?: number): Row | undefined {
    const connection = this.database.connection;
    return (versionNumber === undefined
      ? connection.prepare('select * from figure_templates where name = ? order by version desc limit 1').get(name)
      : connection.prepare('select * from figure_templates where name = ? and version = ?').get(name, versionNumber)) as Row | undefined;
  }
}

function version(row: Row): TemplateVersion {
  return {
    name: row.name,
    version: row.version,
    description: row.description,
    sha256: row.sha256,
    published_by: { role: row.published_by_role, name: row.published_by_name },
    published_at: row.published_at
  };
}

function missing(name: string, versionNumber: number | undefined): string {
  return versionNumber === undefined ? `template: no template is saved as "${name}"; template_list shows them` : `template: "${name}" has no version ${versionNumber}`;
}

// The draft the schema names, else draft-07. Schemas never load remote refs.
function compile(schema: Record<string, unknown>): ValidateFunction {
  const draft = typeof schema.$schema === 'string' ? schema.$schema : '';
  const options = { allErrors: true, strict: false } as const;
  const ajv = draft.includes('2020-12') ? new Ajv2020(options) : draft.includes('2019-09') ? new Ajv2019(options) : new Ajv(options);
  const validate = ajv.compile(schema);
  // An $async schema validates through a promise, which would read as valid.
  if ((validate as { $async?: unknown }).$async) throw new Error('$async schemas are not supported');
  return validate;
}

// Field-level messages an agent can act on, such as
// "findings[2].kind must be one of "must", "should"".
export function formatSchemaErrors(errors: ErrorObject[]): string[] {
  const messages: string[] = [];
  for (const error of errors) {
    const at = fieldPath(error.instancePath);
    const params = error.params as Record<string, unknown>;
    let message: string;
    if (error.keyword === 'enum' && Array.isArray(params.allowedValues)) message = `${at} must be one of ${params.allowedValues.map((value) => JSON.stringify(value)).join(', ')}`;
    else if (error.keyword === 'const') message = `${at} must be ${JSON.stringify(params.allowedValue)}`;
    else if (error.keyword === 'required' && typeof params.missingProperty === 'string') message = `${fieldPath(error.instancePath, params.missingProperty)} is required`;
    else if (error.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') message = `${at} has an unknown field "${params.additionalProperty}"`;
    else message = `${at} ${error.message ?? 'is invalid'}`;
    if (!messages.includes(message)) messages.push(message);
  }
  if (messages.length <= MAX_ERRORS) return messages;
  return [...messages.slice(0, MAX_ERRORS), `and ${messages.length - MAX_ERRORS} more`];
}

// A JSON pointer as a path, such as /findings/2/kind as findings[2].kind.
function fieldPath(pointer: string, child?: string): string {
  const parts = pointer.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (child !== undefined) parts.push(child);
  let path = '';
  for (const part of parts) {
    if (/^\d+$/.test(part)) path += `[${part}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) path += path ? `.${part}` : part;
    else path += `[${JSON.stringify(part)}]`;
  }
  return path || 'data';
}
