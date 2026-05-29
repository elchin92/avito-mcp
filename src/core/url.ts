export type Primitive = string | number | boolean;
export type QueryValue = Primitive | Primitive[] | null | undefined;

/**
 * Substitutes path parameters into a template ("/items/{item_id}/"), url-encoding the values.
 * Throws an Error if an unfilled {placeholder} remains in the template.
 */
export function fillPath(template: string, pathParams: Record<string, Primitive> = {}): string {
  const filled = template.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = pathParams[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(`Missing path parameter: ${key} (template: ${template})`);
    }
    return encodeURIComponent(String(value));
  });
  return filled;
}

/**
 * Builds a query string from an object. Skips null/undefined. Arrays repeat the key.
 */
export function buildQuery(query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === undefined || v === null) continue;
        params.append(key, String(v));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

/**
 * Full URL: base + path-with-placeholders-resolved + query-string.
 * base without a trailing slash, path with a leading slash.
 */
export function buildUrl(
  baseUrl: string,
  template: string,
  pathParams?: Record<string, Primitive>,
  query?: Record<string, QueryValue>,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = fillPath(template.startsWith('/') ? template : `/${template}`, pathParams);
  return `${base}${path}${buildQuery(query)}`;
}
