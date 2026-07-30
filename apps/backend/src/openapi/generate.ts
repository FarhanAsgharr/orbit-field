/**
 * The OpenAPI document, generated from the application itself.
 *
 * Not written by hand and not kept in a file beside the routes — both drift,
 * silently, and a specification that disagrees with the server is worse than
 * none because people trust it. This walks the Express router that is actually
 * mounted, reads the Zod schemas the request validator is actually using, and
 * describes what it finds.
 *
 * The consequence worth stating: adding a route changes the document, and
 * changing a schema changes the document, without anybody remembering to. The
 * synchronisation test asserts exactly that — every mounted route appears here
 * and every path here is mounted — so the two cannot come apart.
 *
 * OpenAPI 3.1 is used rather than 3.0 because 3.1 *is* JSON Schema 2020-12.
 * `zod-to-json-schema` emits JSON Schema, so under 3.1 the output drops
 * straight in; under 3.0 it would need lossy translation of nullables, unions
 * and const values.
 */

import type { Express, RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { env } from '../config/env.js';
import { AUTH_MARKER, PERMISSION_MARKER } from '../middleware/auth.js';
import type { RequestSchema } from '../middleware/validate.js';
import { SCHEMA_MARKER } from '../middleware/validate.js';

/** A JSON Schema object, as far as this file needs to care. */
type JsonSchema = Record<string, unknown>;

interface OperationSource {
  method: string;
  path: string;
  schemas: RequestSchema | null;
  /** Whether `requireAuth` is on the route, read from its own marker. */
  authenticated: boolean;
  /** The permission `requirePermission` asks for, if any. */
  permission: string | null;
}

/**
 * Express keeps its routing table on a private-ish `_router`, and there is no
 * public accessor for it. Reading it is the price of generating a document
 * from reality instead of from a parallel description somebody maintains.
 */
interface RouterLayer {
  name?: string;
  handle?: RequestHandler & { stack?: RouterLayer[] } & Record<string, unknown>;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ name?: string; handle?: Record<string, unknown> }>;
  };
  regexp?: RegExp;
  keys?: Array<{ name: string }>;
}

/**
 * Recover the literal path prefix a nested router was mounted at.
 *
 * Express stores it as a regular expression, so this reads it back. Unpleasant
 * but contained, and the alternative — a hand-maintained list of mount points —
 * is exactly the drift this file exists to remove.
 *
 * The case that matters is a mount carrying a parameter, such as
 * `/clients/:clientId/invitations`. Express compiles that to the source text
 *
 *     ^\/clients(?:\/([^/]+?))\/invitations\/?(?=\/|$)
 *
 * and the parameter has to become `{clientId}` again, using `layer.keys` —
 * which holds the names in the order the groups appear. Note the character
 * class is `[^/]`, unescaped, while the literal separators around it are
 * `\/`: getting that distinction wrong leaves the raw group in the path, which
 * is exactly what the first version of this did.
 */
function mountPath(layer: RouterLayer): string {
  const source = layer.regexp?.source;
  if (!source || source === '^\\/?(?=\\/|$)') return '';

  const names = (layer.keys ?? []).map((k) => k.name);
  let index = 0;

  const path = source
    // Anchors and the trailing lookahead Express appends to every mount.
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\$$/, '')
    // Each parameter group becomes the named placeholder it stands for.
    .replace(/\(\?:\\\/\(\[\^\/]\+\?\)\)/g, () => {
      const name = names[index++];
      return name ? `/{${name}}` : '';
    })
    // Whatever escaping is left is just a literal slash.
    .replace(/\\\//g, '/');

  return path.replace(/\/+$/, '');
}

/** Express writes `:id`; OpenAPI wants `{id}`. */
const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+/g, '/');

/** Walk the mounted router and collect every operation with its schemas. */
function collectOperations(app: Express): OperationSource[] {
  const found: OperationSource[] = [];

  const walk = (stack: RouterLayer[], prefix: string): void => {
    for (const layer of stack) {
      if (layer.route) {
        const handlers = layer.route.stack ?? [];
        const carrier = handlers.find((h) => h.handle && SCHEMA_MARKER in h.handle);
        const schemas = carrier
          ? ((carrier.handle as Record<symbol, unknown>)[SCHEMA_MARKER] as RequestSchema)
          : null;

        /*
         * Auth and permission are read from markers the middleware sets, not
         * from handler names: `requireAuth` is wrapped by `asyncHandler` and
         * reaches Express anonymous, so names would silently report every
         * endpoint as public.
         */
        const authenticated = handlers.some((h) => h.handle && AUTH_MARKER in h.handle);
        const permissionCarrier = handlers.find((h) => h.handle && PERMISSION_MARKER in h.handle);
        const permission = permissionCarrier
          ? ((permissionCarrier.handle as Record<symbol, unknown>)[PERMISSION_MARKER] as string)
          : null;

        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          found.push({
            method,
            path: toOpenApiPath(`${prefix}${layer.route.path}`.replace(/\/$/, '') || '/'),
            schemas,
            authenticated,
            permission,
          });
        }
        continue;
      }

      if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, `${prefix}${mountPath(layer)}`);
      }
    }
  };

  const router = (app as unknown as { _router?: { stack: RouterLayer[] } })._router;
  if (router) walk(router.stack, '');
  return found;
}

/**
 * Convert a Zod schema to JSON Schema, inlined rather than referenced.
 *
 * `jsonSchema2019-09` is the closest dialect this converter emits to the
 * 2020-12 that OpenAPI 3.1 is built on. The difference between them does not
 * reach anything these schemas use — no dynamic references, no `$recursiveRef`
 * — so the output is valid 3.1 as it stands.
 *
 * `$schema` is stripped: 3.1 permits it, but repeating the dialect on every
 * operation is noise in a document people read.
 */
function toJsonSchema(schema: ZodTypeAny): JsonSchema {
  const { $schema: _dialect, ...json } = zodToJsonSchema(schema, {
    // Inlined rather than referenced, so each operation reads on its own —
    // which is what somebody looking at the rendered page actually wants.
    $refStrategy: 'none',
    target: 'jsonSchema2019-09',
  }) as JsonSchema;
  return json;
}

/**
 * Turn a JSON Schema object into OpenAPI parameters.
 *
 * Path and query parameters are described individually rather than as one
 * schema, because that is what renders as a labelled, per-parameter form in
 * both Swagger UI and ReDoc.
 */
function parametersFrom(
  schema: ZodTypeAny | undefined,
  location: 'path' | 'query',
): Array<Record<string, unknown>> {
  if (!schema) return [];
  const json = toJsonSchema(schema);
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: location,
    // A path parameter is required by definition; a missing one is a
    // different route, not an optional value.
    required: location === 'path' ? true : required.has(name),
    schema: propertySchema,
    ...(propertySchema.description ? { description: propertySchema.description } : {}),
  }));
}

/** Group operations under a tag, so the rendered page has sections. */
const DOC_ROUTES = new Set(['docs', 'redoc', 'openapi.json', 'openapi.yaml']);

function tagFor(path: string): string {
  const segments = path.split('/').filter(Boolean);
  // Strip the version prefix: every path carries it, so it groups nothing.
  const meaningful = segments.filter((s) => s !== 'api' && !/^v\d+$/.test(s));
  const first = meaningful[0] ?? 'root';
  // These are the pages you are reading this on. One section, not four.
  if (DOC_ROUTES.has(first)) return 'documentation';
  return first.startsWith('{') ? (meaningful[1] ?? 'root') : first;
}

const RESPONSES = {
  '400': { description: 'The request could not be parsed.' },
  '401': { description: 'Authentication is required, or the session has expired.' },
  '403': { description: 'Authenticated, but not permitted.' },
  '404': { description: 'No such record, or none the caller may see.' },
  '409': { description: 'The request conflicts with the current state.' },
  '422': { description: 'The request was well formed but failed validation.' },
  '429': { description: 'Rate limited. Retry after the interval in `Retry-After`.' },
  '500': { description: 'An unexpected error. Quote the request id when reporting it.' },
} as const;

export interface OpenApiDocument {
  openapi: string;
  info: Record<string, unknown>;
  servers: Array<Record<string, unknown>>;
  tags: Array<Record<string, unknown>>;
  components: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
}

/** Build the document for a mounted application. */
export function generateOpenApiDocument(app: Express): OpenApiDocument {
  const operations = collectOperations(app);
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  for (const operation of operations) {
    const tag = tagFor(operation.path);
    tags.add(tag);

    const parameters = [
      ...parametersFrom(operation.schemas?.params, 'path'),
      ...parametersFrom(operation.schemas?.query, 'query'),
    ];

    const entry: Record<string, unknown> = {
      tags: [tag],
      ...(operation.permission
        ? { description: `Requires the \`${operation.permission}\` permission.` }
        : {}),
      operationId: `${operation.method}${operation.path.replace(/[^A-Za-z0-9]+/g, '_')}`,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(operation.schemas?.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: toJsonSchema(operation.schemas.body) } },
            },
          }
        : {}),
      responses: {
        '200': { description: 'Success.' },
        ...(operation.method === 'post' ? { '201': { description: 'Created.' } } : {}),
        ...(operation.method === 'delete' ? { '204': { description: 'Deleted.' } } : {}),
        ...RESPONSES,
      },
      ...(operation.authenticated ? { security: [{ bearerAuth: [] }] } : { security: [] }),
    };

    paths[operation.path] ??= {};
    paths[operation.path]![operation.method] = entry;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Orbit Field API',
      version: '1.0.0',
      description:
        'Offline-first inspection platform. Every endpoint is scoped to the caller’s ' +
        'organisation; a record belonging to another company answers 404 rather than 403, ' +
        'because confirming that it exists is itself a disclosure.\n\n' +
        'This document is generated from the running application’s routes and validation ' +
        'schemas, so it cannot describe an endpoint the server does not have.',
    },
    servers: [
      { url: 'https://orbit-field-api.vercel.app', description: 'Production' },
      { url: `http://localhost:${env.PORT}`, description: 'Local development' },
    ],
    tags: [...tags].sort().map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'An access token from `POST /api/v1/auth/login`. Endpoints that synchronise ' +
            'also require the `X-Device-Id` header naming an enrolled device.',
        },
      },
    },
    paths,
  };
}
