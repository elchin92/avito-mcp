import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';

import type { Config } from '../src/config.js';
import { AvitoClient } from '../src/core/client.js';
import { PendingActionStore } from '../src/core/pending-actions.js';
import type { DomainRegister, ToolContext, ToolRisk } from '../src/core/tool-factory.js';
import { register as auth } from '../src/domains/auth.js';
import { register as autoload } from '../src/domains/autoload.js';
import { register as calltracking } from '../src/domains/calltracking.js';
import { register as cpaAuction } from '../src/domains/cpa_auction.js';
import { register as cpaTarget } from '../src/domains/cpa_target_action.js';
import { register as cpa } from '../src/domains/cpa.js';
import { register as delivery } from '../src/domains/delivery.js';
import { register as hierarchy } from '../src/domains/hierarchy.js';
import { register as items } from '../src/domains/items.js';
import { register as messengerDiscounts } from '../src/domains/messenger_discounts.js';
import { register as messenger } from '../src/domains/messenger.js';
import { register as orders } from '../src/domains/orders.js';
import { register as promotion } from '../src/domains/promotion.js';
import { register as reviews } from '../src/domains/reviews.js';
import { register as stock } from '../src/domains/stock.js';
import { register as tariffs } from '../src/domains/tariffs.js';
import { register as trxpromo } from '../src/domains/trxpromo.js';
import { register as user } from '../src/domains/user.js';
import { toSnakeCase } from '../src/meta/tool-naming.js';

type JsonObject = Record<string, unknown>;

interface StaticTool {
  name: string;
  method: string;
  path: string;
  source: string;
  pathParams: string[];
  queryParams: string[];
  bodyFields: string[];
  bodyDefaults: Record<string, { expression: string; literal?: string | number | boolean }>;
  bodyContentType?: string;
  hasBody: boolean;
  hasBodyTransform: boolean;
  hasCustomExecute: boolean;
  hasStaticHeaders: boolean;
  injectProfileId?: string;
  allowGetBody: boolean;
}

interface Operation {
  method: string;
  path: string;
  operationId?: string;
  operation: JsonObject;
  pathItem: JsonObject;
  document: JsonObject;
}

interface RuntimeTool {
  schema: JsonObject;
  risk?: string;
  environment?: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOMAIN_FILES = {
  'auth.ts': { swagger: 'authorization.json', prefix: 'auth', register: auth },
  'autoload.ts': { swagger: 'autoload.json', prefix: 'autoload', register: autoload },
  'calltracking.ts': {
    swagger: 'calltracking.json',
    prefix: 'calltracking',
    register: calltracking,
  },
  'cpa.ts': { swagger: 'cpa.json', prefix: 'cpa', register: cpa },
  'cpa_auction.ts': { swagger: 'cpa-auction.json', prefix: 'cpa_auction', register: cpaAuction },
  'cpa_target_action.ts': {
    swagger: 'cpa-target-action.json',
    prefix: 'cpa_target',
    register: cpaTarget,
  },
  'delivery.ts': { swagger: 'delivery.json', prefix: 'delivery', register: delivery },
  'hierarchy.ts': {
    swagger: 'account-hierarchy.json',
    prefix: 'hierarchy',
    register: hierarchy,
  },
  'items.ts': { swagger: 'items.json', prefix: 'items', register: items },
  'messenger.ts': { swagger: 'messenger.json', prefix: 'messenger', register: messenger },
  'messenger_discounts.ts': {
    swagger: 'messenger-discounts.json',
    prefix: 'msg_discounts',
    register: messengerDiscounts,
  },
  'orders.ts': { swagger: 'orders.json', prefix: 'orders', register: orders },
  'promotion.ts': { swagger: 'promotion.json', prefix: 'promotion', register: promotion },
  'reviews.ts': { swagger: 'reviews.json', prefix: 'reviews', register: reviews },
  'stock.ts': { swagger: 'stock-management.json', prefix: 'stock', register: stock },
  'tariffs.ts': { swagger: 'tariffs.json', prefix: 'tariffs', register: tariffs },
  'trxpromo.ts': { swagger: 'trxpromo.json', prefix: 'trxpromo', register: trxpromo },
  'user.ts': { swagger: 'user.json', prefix: 'user', register: user },
} satisfies Record<string, { swagger: string; prefix: string; register: DomainRegister }>;

const POST_READ_TOOLS = new Set([
  'auth_get_access_token',
  'auth_get_access_token_authorization_code',
  'auth_refresh_access_token_authorization_code',
  'calltracking_get_call_by_id',
  'calltracking_get_calls',
  'cpa_balance_info_v2',
  'cpa_balance_info_v3',
  'cpa_chats_by_time_v1',
  'cpa_chats_by_time_v2',
  'cpa_get_call_by_id_v2',
  'cpa_get_calls_by_time_v2',
  'cpa_phones_info_from_chats',
  'cpa_target_get_promotions_by_item_ids',
  'delivery_check_confirmation_code',
  'delivery_v1_get_announcement_event',
  'delivery_v1_get_change_parcel_info',
  'delivery_v1_get_parcel_info',
  'delivery_v1_get_registered_parcel_id',
  'hierarchy_list_items_by_employee_id_v1',
  'items_post_account_spendings',
  'items_post_calls_stats',
  'items_post_item_analytics',
  'items_post_item_stats_shallow',
  'items_post_vas_prices',
  'messenger_get_subscriptions',
  'msg_discounts_open_api_available',
  'msg_discounts_open_api_stats',
  'msg_discounts_open_api_tariff_info',
  'orders_check_confirmation_code',
  'promotion_get_bbip_forecasts_by_items_v1',
  'promotion_get_bbip_suggests_by_items_v1',
  'promotion_get_dict_of_services_v1',
  'promotion_get_order_status_v1',
  'promotion_get_services_by_items_v1',
  'promotion_list_orders_by_user_v1',
  'stock_get_stocks_info',
  'user_post_operations_history',
]);

const EXPECTED_MUTATION_RISKS = {
  autoload_create_or_update_profile: 'write',
  autoload_create_or_update_profile_v2: 'write',
  autoload_upload: 'public',
  cpa_auction_save_item_bids: 'money',
  cpa_create_complaint_by_action_id: 'public',
  cpa_post_create_complaint: 'public',
  cpa_target_remove_promotion: 'write',
  cpa_target_save_auto_bid: 'money',
  cpa_target_save_manual_bid: 'money',
  delivery_add_areas_sandbox: 'write',
  delivery_add_sorting_center: 'write',
  delivery_add_tags_to_sorting_center: 'write',
  delivery_add_tariff_sandbox_v2: 'write',
  delivery_add_terminals_sandbox: 'write',
  delivery_cancel_announcement_3pl: 'write',
  delivery_change_parcel_result: 'write',
  delivery_change_parcels: 'write',
  delivery_create_announcement_3pl: 'write',
  delivery_create_parcel: 'write',
  delivery_create_sandbox_parcel_v2: 'write',
  delivery_custom_area_schedule: 'write',
  delivery_prohibit_order_acceptance: 'write',
  delivery_sandbox_cancel_parcel: 'write',
  delivery_sandbox_create_announcement: 'write',
  delivery_sandbox_track_announcement: 'write',
  delivery_set_order_properties: 'write',
  delivery_set_order_real_address: 'write',
  delivery_tracking: 'write',
  delivery_update_terms: 'write',
  delivery_v1_cancel_announcement: 'write',
  delivery_v1_cancel_parcel: 'write',
  delivery_v1_change_parcel: 'write',
  delivery_v1_create_announcement: 'write',
  hierarchy_link_items_v1: 'write',
  items_apply_vas: 'money',
  items_put_item_vas: 'money',
  items_put_item_vas_package_v2: 'money',
  items_update_price: 'public',
  messenger_chat_read: 'write',
  messenger_delete_message: 'public',
  messenger_post_blacklist_v2: 'public',
  messenger_post_send_image_message: 'public',
  messenger_post_send_message: 'public',
  messenger_post_webhook_unsubscribe: 'write',
  messenger_post_webhook_v3: 'public',
  messenger_upload_images: 'write',
  msg_discounts_open_api_multi_confirm: 'money',
  msg_discounts_open_api_multi_create: 'write',
  orders_accept_return_order: 'public',
  orders_apply_transition: 'public',
  orders_cnc_set_details: 'write',
  orders_generate_labels: 'write',
  orders_generate_labels_extended: 'write',
  orders_markings: 'write',
  orders_set_courier_delivery_range: 'write',
  orders_set_tracking_number: 'public',
  promotion_create_bbip_order_for_items_v1: 'money',
  reviews_create_review_answer_v1: 'public',
  reviews_remove_review_answer_v1: 'public',
  stock_update_stocks: 'public',
  trxpromo_apply: 'money',
  trxpromo_cancel: 'write',
} satisfies Record<string, ToolRisk>;

/** Explicit, documented deviations in the bundled upstream document itself. */
const CONTRACT_EXCEPTIONS: Record<string, Record<string, string>> = {
  delivery_create_parcel: {
    'body.items[].weight':
      'Swagger requires nonexistent key "values" although the documented property is singular "value".',
    'body.items[].tags': 'Swagger puts enum on the array node instead of its item schema.',
  },
  delivery_add_sorting_center: {
    'body[].address.country':
      'Swagger required list misspells the documented property as "conuntry".',
    'body[].directionTag': 'Swagger requires directionTag but omits its property declaration.',
  },
  delivery_add_terminals_sandbox: {
    'body[].address.country':
      'Swagger required list misspells the documented property as "conuntry".',
  },
  items_get_items_info: {
    'query.status':
      'Swagger declares a scalar enum but its own example and API contract allow comma-separated enum values.',
  },
  messenger_get_chats_v2: {
    'query.item_ids':
      'Compatibility arm retains the pre-1.2 CSV form; arrays follow the current Swagger.',
    'query.chat_types':
      'Compatibility arm retains the pre-1.2 CSV form; arrays follow the current Swagger.',
  },
  messenger_get_voice_files: {
    'query.voice_ids':
      'Compatibility arm retains the pre-1.2 CSV form; arrays follow the current Swagger.',
  },
  messenger_upload_images: {
    body: 'Local paths are converted by a code-owned custom executor into multipart uploadfile[] parts.',
  },
  orders_generate_labels: {
    'body.orderIDs.maxItems':
      'The shared ordersLabelsRequest says 50, but this operation summary and description both explicitly allow 100 orders.',
  },
  orders_generate_labels_extended: {
    'body.orderIDs.maxItems':
      'The shared ordersLabelsRequest says 50, but this operation summary and description both explicitly allow 1000 orders.',
  },
  trxpromo_get_commissions: {
    'header.x-oauth-flow':
      'Internal gateway header in the bundled Swagger; OAuth bearer auth supplies identity.',
    'header.x-authenticated-userid':
      'Internal gateway header in the bundled Swagger; OAuth bearer auth supplies identity.',
  },
  trxpromo_apply: {
    'header.x-oauth-flow':
      'Internal gateway header in the bundled Swagger; OAuth bearer auth supplies identity.',
    'header.x-authenticated-userid':
      'Internal gateway header in the bundled Swagger; OAuth bearer auth supplies identity.',
  },
  trxpromo_cancel: {
    'header.x-oauth-flow':
      'Internal gateway header in the bundled Swagger; OAuth bearer auth supplies identity.',
    'header.x-authenticated-userid':
      'Internal gateway header in the bundled Swagger; OAuth bearer auth supplies identity.',
  },
};

function makeConfig(): Config {
  return {
    clientId: 'cid',
    clientSecret: 'secret',
    profileId: 12345,
    baseUrl: 'https://api.test.example',
    cpaSource: 'avito-mcp-contract-test',
    tokenFile: '/tmp/avito-mcp-openapi-contract-token.json',
    logLevel: 'fatal',
    mode: 'full_access',
    allowTools: [],
    denyTools: [],
    exposeAuthTools: true,
    allowedUploadDirs: ['/tmp'],
    maxUploadMb: 15,
    confirmationMode: 'off',
    confirmationTtlSec: 900,
    maxBinaryMb: 20,
    dryRunDefault: false,
    idempotencyTtlSec: 3600,
    tokenLockTimeoutMs: 30_000,
    http: {
      transport: 'stdio',
      host: '127.0.0.1',
      port: 3000,
      publicUrl: 'http://127.0.0.1:3000',
      auth: 'oauth',
      authTokens: [],
      allowNoAuth: false,
      allowedHosts: [],
      allowedOrigins: [],
      oauthTokenTtlSec: 3600,
      maxSessions: 100,
      sessionIdleSec: 1800,
    },
    webhook: {
      enabled: false,
      publicUrl: 'http://127.0.0.1:3000',
      path: '/avito/webhook',
      bufferSize: 100,
    },
  } as Config;
}

function propertyName(node: ts.PropertyName, source: ts.SourceFile): string {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return node.getText(source);
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  source: ts.SourceFile,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name, source) === name,
  );
}

function hasObjectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  source: ts.SourceFile,
): boolean {
  return object.properties.some(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      propertyName(candidate.name, source) === name,
  );
}

function stringProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  source: ts.SourceFile,
): string | undefined {
  const property = objectProperty(object, name, source);
  return property && ts.isStringLiteralLike(property.initializer)
    ? property.initializer.text
    : undefined;
}

function stringArrayProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  source: ts.SourceFile,
): string[] {
  const property = objectProperty(object, name, source);
  if (!property || !ts.isArrayLiteralExpression(property.initializer)) return [];
  return property.initializer.elements
    .filter(ts.isStringLiteralLike)
    .map((element) => element.text);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function returnedObjectLiteral(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
  const current = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(current)) return current;
  if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) return undefined;
  if (!ts.isBlock(current.body)) {
    const body = unwrapExpression(current.body);
    return ts.isObjectLiteralExpression(body) ? body : undefined;
  }
  const returned = current.body.statements.find(ts.isReturnStatement)?.expression;
  if (!returned) return undefined;
  const body = unwrapExpression(returned);
  return ts.isObjectLiteralExpression(body) ? body : undefined;
}

function literalValue(expression: ts.Expression): string | number | boolean | undefined {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) return current.text;
  if (ts.isNumericLiteral(current)) return Number(current.text);
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

function bodyDefaultExpressions(
  body: ts.ObjectLiteralExpression | undefined,
  source: ts.SourceFile,
): StaticTool['bodyDefaults'] {
  if (!body) return {};
  const defaults = objectProperty(body, 'defaults', source);
  if (!defaults) return {};
  const object = returnedObjectLiteral(defaults.initializer);
  if (!object) return {};
  const result: StaticTool['bodyDefaults'] = {};
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    result[propertyName(property.name, source)] = {
      expression: property.initializer.getText(source),
      literal: literalValue(property.initializer),
    };
  }
  return result;
}

function extractStaticTools(sourceName: keyof typeof DOMAIN_FILES): StaticTool[] {
  const path = resolve(ROOT, 'src', 'domains', sourceName);
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const tools: StaticTool[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'defineTool' &&
      node.arguments[2] &&
      ts.isObjectLiteralExpression(node.arguments[2])
    ) {
      const object = node.arguments[2];
      const name = stringProperty(object, 'name', source);
      const method = stringProperty(object, 'method', source);
      const toolPath = stringProperty(object, 'path', source);
      if (!name || !method || !toolPath) throw new Error(`Non-static ToolSpec in ${sourceName}`);
      const bodyProperty = objectProperty(object, 'body', source);
      const body =
        bodyProperty && ts.isObjectLiteralExpression(bodyProperty.initializer)
          ? bodyProperty.initializer
          : undefined;
      tools.push({
        name,
        method,
        path: toolPath,
        source: sourceName,
        pathParams: stringArrayProperty(object, 'pathParams', source),
        queryParams: stringArrayProperty(object, 'queryParams', source),
        bodyFields: body ? stringArrayProperty(body, 'fields', source) : [],
        bodyDefaults: bodyDefaultExpressions(body, source),
        bodyContentType: body ? stringProperty(body, 'contentType', source) : undefined,
        hasBody: body !== undefined,
        hasBodyTransform: body ? objectProperty(body, 'transform', source) !== undefined : false,
        hasCustomExecute: objectProperty(object, 'customExecute', source) !== undefined,
        hasStaticHeaders: hasObjectProperty(object, 'staticHeaders', source),
        injectProfileId: stringProperty(object, 'injectProfileId', source),
        allowGetBody:
          objectProperty(object, 'allowGetBody', source)?.initializer.kind ===
          ts.SyntaxKind.TrueKeyword,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return tools;
}

function normalizePath(path: string): string {
  return path.replace(/\p{Cf}/gu, '');
}

function loadDocument(file: string): JsonObject {
  return JSON.parse(readFileSync(resolve(ROOT, 'swaggers', file), 'utf8')) as JsonObject;
}

function operationsFor(document: JsonObject): Operation[] {
  const operations: Operation[] = [];
  for (const [path, rawPathItem] of Object.entries(document.paths as JsonObject)) {
    const pathItem = rawPathItem as JsonObject;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId:
          typeof (operation as JsonObject).operationId === 'string'
            ? ((operation as JsonObject).operationId as string)
            : undefined,
        operation: operation as JsonObject,
        pathItem,
        document,
      });
    }
  }
  return operations;
}

function resolvePointer(document: JsonObject, pointer: string): unknown {
  return pointer
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (value, part) => (value as JsonObject)[part.replaceAll('~1', '/').replaceAll('~0', '~')],
      document,
    );
}

function dereference(document: JsonObject, value: unknown): JsonObject {
  let current = value as JsonObject;
  const seen = new Set<string>();
  while (typeof current?.$ref === 'string') {
    const ref = current.$ref;
    if (seen.has(ref)) break;
    seen.add(ref);
    current = resolvePointer(document, ref) as JsonObject;
  }
  return current ?? {};
}

function runtimeTools(): Map<string, RuntimeTool> {
  const tools = new Map<string, RuntimeTool>();
  const server = {
    registerTool(
      name: string,
      config: {
        inputSchema?: ZodRawShape;
        _meta?: { risk?: string; environment?: string };
      },
    ): void {
      tools.set(name, {
        schema: z.toJSONSchema(z.object(config.inputSchema ?? {}), {
          reused: 'inline',
        }) as JsonObject,
        risk: config._meta?.risk,
        environment: config._meta?.environment,
      });
    },
  } as unknown as McpServer;
  const config = makeConfig();
  const context: ToolContext = {
    client: new AvitoClient(config),
    config,
    pendingStore: new PendingActionStore(900_000),
  };
  for (const entry of Object.values(DOMAIN_FILES)) entry.register(server, context);
  return tools;
}

function matchOperation(
  tool: StaticTool,
  operations: Operation[],
  prefix: string,
): Operation | undefined {
  const candidates = operations.filter(
    (operation) =>
      operation.method === tool.method &&
      normalizePath(operation.path) === normalizePath(tool.path),
  );
  if (candidates.length <= 1) return candidates[0];
  return candidates.find(
    (operation) =>
      operation.operationId !== undefined &&
      `${prefix}_${toSnakeCase(operation.operationId)}` === tool.name,
  );
}

function schemaProperties(schema: JsonObject): JsonObject {
  return (schema.properties as JsonObject | undefined) ?? {};
}

function isRequired(schema: JsonObject, property: string): boolean {
  return Array.isArray(schema.required) && schema.required.includes(property);
}

function schemaType(schema: JsonObject): string | undefined {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((candidate): candidate is string => candidate !== 'null');
  }
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf
      .map((candidate) => schemaType(candidate as JsonObject))
      .find((candidate) => candidate !== undefined && candidate !== 'null');
    if (nonNull) return nonNull;
  }
  if (schema.properties) return 'object';
  if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
    return typeof schema.enum[0] === 'number' ? 'number' : typeof schema.enum[0];
  }
  return undefined;
}

function unwrapNullableSchema(schema: JsonObject): JsonObject {
  if (!Array.isArray(schema.anyOf)) return schema;
  const nonNull = schema.anyOf.filter(
    (candidate) => schemaType(candidate as JsonObject) !== 'null',
  ) as JsonObject[];
  return nonNull.length === 1 ? (nonNull[0] ?? schema) : schema;
}

function schemaEnumValues(schema: JsonObject): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (schema.const !== undefined) return [schema.const];
  if (!Array.isArray(schema.anyOf)) return undefined;
  const values = schema.anyOf.flatMap(
    (candidate) => schemaEnumValues(candidate as JsonObject) ?? [],
  );
  return values.length > 0 ? values : undefined;
}

function exception(tool: string, path: string): string | undefined {
  return CONTRACT_EXCEPTIONS[tool]?.[path];
}

function compareSchema(
  toolName: string,
  path: string,
  openApiRaw: unknown,
  toolRaw: unknown,
  document: JsonObject,
  errors: string[],
  depth = 0,
): void {
  if (exception(toolName, path) || depth > 8) return;
  const openApi = dereference(document, openApiRaw);
  const toolContainer = toolRaw as JsonObject | undefined;
  if (!toolContainer) {
    errors.push(`${toolName} ${path}: missing ToolSpec schema`);
    return;
  }
  const tool = unwrapNullableSchema(toolContainer);

  const expectedType = schemaType(openApi);
  const actualType = schemaType(tool);
  if (expectedType && actualType && expectedType !== actualType) {
    const compatibleNumber = expectedType === 'integer' && actualType === 'number';
    if (!compatibleNumber)
      errors.push(`${toolName} ${path}: type ${actualType}, Swagger ${expectedType}`);
  } else if (expectedType && !actualType) {
    errors.push(`${toolName} ${path}: missing type ${expectedType}`);
  }

  const expectedEnum = Array.isArray(openApi.enum) ? openApi.enum : undefined;
  if (expectedEnum && expectedType !== 'array') {
    const actualValues = schemaEnumValues(toolContainer);
    if (!actualValues) {
      errors.push(`${toolName} ${path}: missing Swagger enum`);
    } else {
      const invalid = actualValues.filter((value) => !expectedEnum.includes(value));
      if (invalid.length > 0)
        errors.push(`${toolName} ${path}: enum permits ${JSON.stringify(invalid)}`);
    }
  }

  for (const [keyword, direction] of [
    ['maximum', 'max'],
    ['maxItems', 'max'],
    ['minimum', 'min'],
    ['minItems', 'min'],
  ] as const) {
    if (exception(toolName, `${path}.${keyword}`)) continue;
    const expected = openApi[keyword];
    if (typeof expected !== 'number') continue;
    const actual = tool[keyword];
    const tooLoose =
      typeof actual !== 'number' || (direction === 'max' ? actual > expected : actual < expected);
    if (tooLoose) {
      errors.push(`${toolName} ${path}: ${keyword}=${String(actual)}, Swagger ${expected}`);
    }
  }

  if (expectedType === 'array' && openApi.items) {
    compareSchema(toolName, `${path}[]`, openApi.items, tool.items, document, errors, depth + 1);
  }

  if (expectedType === 'object') {
    const expectedProperties = schemaProperties(openApi);
    const actualProperties = schemaProperties(tool);
    for (const required of (openApi.required as string[] | undefined) ?? []) {
      const childPath = `${path}.${required}`;
      if (exception(toolName, childPath)) continue;
      if (!(required in expectedProperties)) continue;
      if (!(required in actualProperties) || !isRequired(tool, required)) {
        errors.push(`${toolName} ${childPath}: required by Swagger`);
      }
    }
    for (const [property, expectedProperty] of Object.entries(expectedProperties)) {
      if (!(property in actualProperties)) continue;
      compareSchema(
        toolName,
        `${path}.${property}`,
        expectedProperty,
        actualProperties[property],
        document,
        errors,
        depth + 1,
      );
    }
  }
}

function operationParameters(operation: Operation): JsonObject[] {
  const raw = [
    ...((operation.pathItem.parameters as unknown[]) ?? []),
    ...((operation.operation.parameters as unknown[]) ?? []),
  ];
  return raw.map((parameter) => dereference(operation.document, parameter));
}

function requestSchema(
  operation: Operation,
): { contentType: string; schema: JsonObject } | undefined {
  const rawBody = operation.operation.requestBody;
  if (!rawBody) return undefined;
  const body = dereference(operation.document, rawBody);
  const content = body.content as JsonObject | undefined;
  if (!content) return undefined;
  const contentType =
    ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'].find(
      (candidate) => content[candidate],
    ) ?? Object.keys(content)[0];
  if (!contentType) return undefined;
  const media = content[contentType] as JsonObject;
  return { contentType, schema: dereference(operation.document, media.schema) };
}

const ARRAY_BODY_FIELDS: Record<string, string> = {
  delivery_add_areas_sandbox: 'areas',
  delivery_add_sorting_center: 'centers',
  delivery_add_tags_to_sorting_center: 'tagged',
  delivery_add_terminals_sandbox: 'terminals',
  delivery_custom_area_schedule: 'schedules',
  delivery_update_terms: 'zones',
};

describe('OpenAPI to ToolSpec contract', () => {
  const staticTools = Object.keys(DOMAIN_FILES).flatMap((source) =>
    extractStaticTools(source as keyof typeof DOMAIN_FILES),
  );
  const registeredTools = runtimeTools();

  it('maps every Swagger operation to exactly typed method/path ToolSpecs', () => {
    const errors: string[] = [];
    for (const [source, entry] of Object.entries(DOMAIN_FILES)) {
      const operations = operationsFor(loadDocument(entry.swagger));
      const tools = staticTools.filter((tool) => tool.source === source);
      for (const tool of tools) {
        if (!matchOperation(tool, operations, entry.prefix)) {
          errors.push(`${tool.name}: ${tool.method} ${tool.path} not found in ${entry.swagger}`);
        }
      }
      for (const operation of operations) {
        const covered = tools.some(
          (tool) =>
            tool.method === operation.method &&
            normalizePath(tool.path) === normalizePath(operation.path),
        );
        if (!covered)
          errors.push(`${entry.swagger}: uncovered ${operation.method} ${operation.path}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('checks required fields, primitive/nested types, enums, limits, headers and encoding', () => {
    const errors: string[] = [];
    for (const tool of staticTools) {
      const entry = DOMAIN_FILES[tool.source as keyof typeof DOMAIN_FILES];
      const operation = matchOperation(
        tool,
        operationsFor(loadDocument(entry.swagger)),
        entry.prefix,
      );
      if (!operation) continue;
      const runtime = registeredTools.get(tool.name);
      if (!runtime) {
        errors.push(`${tool.name}: missing runtime input schema`);
        continue;
      }
      const schema = runtime.schema;
      const inputProperties = schemaProperties(schema);

      for (const parameter of operationParameters(operation)) {
        const location = parameter.in;
        const name = parameter.name;
        if (typeof location !== 'string' || typeof name !== 'string') continue;
        if (location === 'header') {
          if (['Authorization', 'Content-Type', 'X-Is-Employee'].includes(name)) continue;
          if (exception(tool.name, `header.${name}`)) continue;
          if (parameter.required === true && !tool.hasStaticHeaders) {
            errors.push(`${tool.name}: required header ${name} lacks code-owned staticHeaders`);
          }
          continue;
        }
        if (location !== 'path' && location !== 'query') continue;
        const declared = location === 'path' ? tool.pathParams : tool.queryParams;
        const placeholder = [...tool.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        const inputName =
          declared.find((candidate) => candidate === name) ??
          (location === 'path' && placeholder.length === 1 ? placeholder[0] : undefined) ??
          name;
        if (!declared.includes(inputName)) {
          errors.push(`${tool.name}: ${location} parameter ${name} is not encoded as ${location}`);
          continue;
        }
        if (!(inputName in inputProperties)) {
          errors.push(`${tool.name}: missing input for ${location} parameter ${name}`);
          continue;
        }
        const injected = tool.injectProfileId === inputName;
        if (parameter.required === true && !injected && !isRequired(schema, inputName)) {
          errors.push(`${tool.name}: required ${location} parameter ${name} is optional`);
        }
        compareSchema(
          tool.name,
          `${location}.${name}`,
          parameter.schema,
          inputProperties[inputName],
          operation.document,
          errors,
        );
      }

      const request = requestSchema(operation);
      if (!request) continue;
      if (exception(tool.name, 'body')) continue;
      if (!tool.hasBody && !tool.hasCustomExecute) {
        errors.push(`${tool.name}: Swagger request body is not encoded by ToolSpec`);
        continue;
      }
      if (tool.method === 'GET' && !tool.allowGetBody) {
        errors.push(`${tool.name}: GET request body lacks code-owned allowGetBody`);
      }
      if (tool.bodyContentType && tool.bodyContentType !== request.contentType) {
        errors.push(
          `${tool.name}: body content type ${tool.bodyContentType}, Swagger ${request.contentType}`,
        );
      }
      if (schemaType(request.schema) === 'array') {
        const field = ARRAY_BODY_FIELDS[tool.name];
        if (!field || !(field in inputProperties)) {
          errors.push(`${tool.name}: top-level array body lacks an explicit wrapper mapping`);
          continue;
        }
        compareSchema(
          tool.name,
          'body',
          request.schema,
          inputProperties[field],
          operation.document,
          errors,
        );
        continue;
      }

      const expectedProperties = schemaProperties(request.schema);
      for (const [property, expected] of Object.entries(expectedProperties)) {
        if (!(property in inputProperties)) {
          const ownedDefault = tool.bodyDefaults[property];
          if (ownedDefault) {
            const expectedSchema = dereference(operation.document, expected);
            if (
              expectedSchema.default !== undefined &&
              ownedDefault.literal !== expectedSchema.default
            ) {
              errors.push(
                `${tool.name} body.${property}: default=${JSON.stringify(ownedDefault.literal)}, Swagger ${JSON.stringify(expectedSchema.default)}`,
              );
            }
            if (ownedDefault.literal !== undefined) {
              const literalType =
                typeof ownedDefault.literal === 'number' && Number.isInteger(ownedDefault.literal)
                  ? 'integer'
                  : typeof ownedDefault.literal;
              compareSchema(
                tool.name,
                `body.${property}`,
                expected,
                { type: literalType, const: ownedDefault.literal },
                operation.document,
                errors,
              );
            } else if (ownedDefault.expression.length === 0) {
              errors.push(`${tool.name} body.${property}: empty code-owned default expression`);
            }
          } else if (isRequired(request.schema, property)) {
            errors.push(`${tool.name} body.${property}: required by Swagger`);
          }
          continue;
        }
        if (
          tool.bodyFields.length > 0 &&
          !tool.bodyFields.includes(property) &&
          !tool.hasBodyTransform
        ) {
          errors.push(`${tool.name} body.${property}: input is not encoded in request body`);
        }
        if (isRequired(request.schema, property) && !isRequired(schema, property)) {
          errors.push(`${tool.name} body.${property}: required by Swagger`);
        }
        compareSchema(
          tool.name,
          `body.${property}`,
          expected,
          inputProperties[property],
          operation.document,
          errors,
        );
      }
    }
    expect(errors).toEqual([]);
  });

  it('keeps every non-GET operation in an explicitly reviewed risk class', () => {
    const errors: string[] = [];
    const audited = staticTools.filter((tool) => tool.method !== 'GET');
    for (const tool of audited) {
      const risk = registeredTools.get(tool.name)?.risk;
      if (POST_READ_TOOLS.has(tool.name)) {
        if (risk !== 'read' && risk !== 'sensitive') {
          errors.push(`${tool.name}: reviewed POST-as-read has risk=${String(risk)}`);
        }
        continue;
      }
      const expected = EXPECTED_MUTATION_RISKS[tool.name as keyof typeof EXPECTED_MUTATION_RISKS];
      if (!expected) {
        errors.push(`${tool.name}: non-GET operation lacks reviewed risk classification`);
      } else if (risk !== expected) {
        errors.push(`${tool.name}: risk=${String(risk)}, expected ${expected}`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('retains documented pre-1.2 scalar/CSV inputs alongside corrected Swagger types', () => {
    const schemaFor = (tool: string, property: string): JsonObject => {
      const schema = registeredTools.get(tool)?.schema;
      return schemaProperties(schema ?? {})[property] as JsonObject;
    };
    const unionTypes = (schema: JsonObject): unknown[] =>
      ((schema.anyOf as JsonObject[] | undefined) ?? []).map((entry) => entry.type);

    expect(unionTypes(schemaFor('messenger_get_chats_v2', 'item_ids'))).toEqual([
      'array',
      'string',
    ]);
    expect(unionTypes(schemaFor('messenger_get_chats_v2', 'chat_types'))).toEqual([
      'array',
      'string',
    ]);
    expect(unionTypes(schemaFor('messenger_get_voice_files', 'voice_ids'))).toEqual([
      'array',
      'string',
    ]);
    for (const [tool, property] of [
      ['delivery_add_areas_sandbox', 'tariff_id'],
      ['delivery_add_tags_to_sorting_center', 'tariff_id'],
      ['delivery_add_terminals_sandbox', 'tariff_id'],
      ['delivery_update_terms', 'tariff_id'],
      ['delivery_get_task', 'task_id'],
    ] as const) {
      expect(unionTypes(schemaFor(tool, property))).toEqual(['integer', 'string']);
    }
  });

  it('marks every delivery sandbox operation as sandbox metadata', () => {
    const wrong = staticTools
      .filter(
        (tool) => tool.source === 'delivery.ts' && normalizePath(tool.path).includes('sandbox'),
      )
      .filter((tool) => registeredTools.get(tool.name)?.environment !== 'sandbox')
      .map((tool) => tool.name);
    expect(wrong).toEqual([]);
  });
});

describe('domain transport contract wiring', () => {
  function captureHandlers(register: DomainRegister): {
    handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>;
    request: ReturnType<typeof vi.fn>;
  } {
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool(
        name: string,
        _config: unknown,
        handler: (args: Record<string, unknown>) => Promise<unknown>,
      ): void {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    const request = vi.fn().mockResolvedValue({ status: 200, data: {}, headers: new Headers() });
    const config = makeConfig();
    register(server, {
      client: { request } as unknown as AvitoClient,
      config,
      pendingStore: new PendingActionStore(900_000),
    });
    return { handlers, request };
  }

  it('passes operator-controlled X-Source from every CPA spec into RequestOptions', async () => {
    const { handlers, request } = captureHandlers(cpa);
    expect(handlers.size).toBe(11);
    for (const handler of handlers.values()) {
      request.mockClear();
      // Invalid business args are irrelevant here: defineTool forwards them without SDK validation.
      await handler({});
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          staticHeaders: { 'X-Source': 'avito-mcp-contract-test' },
        }),
      );
    }
  });

  it('opts only the documented trxpromo commissions GET into GET-body transport', async () => {
    const { handlers, request } = captureHandlers(trxpromo);
    await handlers.get('trxpromo_get_commissions')?.({ itemIDs: [101, 202] });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: '/trx-promo/1/commissions',
        body: { itemIDs: [101, 202] },
        allowGetBody: true,
      }),
    );

    request.mockClear();
    await handlers.get('trxpromo_apply')?.({ items: [] });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', allowGetBody: undefined }),
    );
  });
});
