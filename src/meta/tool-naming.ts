/**
 * Префиксы доменов — должны совпадать с операционными именами из swagger-файлов.
 * При коллизиях operationId между файлами префикс делает имя уникальным.
 */
export const DOMAIN_PREFIXES = {
  auth: 'auth',
  user: 'user',
  items: 'items',
  messenger: 'messenger',
  autoload: 'autoload',
  orders: 'orders',
  delivery: 'delivery',
  promotion: 'promotion',
  cpa: 'cpa',
  cpa_auction: 'cpa_auction',
  cpa_target: 'cpa_target',
  stock: 'stock',
  hierarchy: 'hierarchy',
  reviews: 'reviews',
  tariffs: 'tariffs',
  trxpromo: 'trxpromo',
  calltracking: 'calltracking',
  msg_discounts: 'msg_discounts',
} as const;

/**
 * camelCase / PascalCase / kebab-case → snake_case.
 *   "getUserBalance"      → "get_user_balance"
 *   "GetTokenOAuthRequest" → "get_token_o_auth_request" (для большинства случаев ок)
 *   "v1-list-items"       → "v1_list_items"
 */
export function toSnakeCase(input: string): string {
  return input
    .replace(/[-\s]+/g, '_')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/** "items" + "getItemInfo" → "items_get_item_info" */
export function toolName(domain: string, operationId: string): string {
  return `${domain}_${toSnakeCase(operationId)}`;
}
