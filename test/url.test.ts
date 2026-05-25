import { describe, it, expect } from 'vitest';
import { fillPath, buildQuery, buildUrl } from '../src/core/url.js';

describe('fillPath', () => {
  it('substitutes simple params', () => {
    expect(fillPath('/items/{id}', { id: 42 })).toBe('/items/42');
  });

  it('url-encodes values', () => {
    expect(fillPath('/users/{name}', { name: 'a b/c' })).toBe('/users/a%20b%2Fc');
  });

  it('handles multiple placeholders', () => {
    expect(
      fillPath('/accounts/{user_id}/items/{item_id}/', { user_id: 1, item_id: 2 }),
    ).toBe('/accounts/1/items/2/');
  });

  it('throws on missing path param', () => {
    expect(() => fillPath('/items/{id}', {})).toThrow(/Missing path parameter: id/);
  });

  it('throws on empty path param', () => {
    expect(() => fillPath('/items/{id}', { id: '' })).toThrow();
  });

  it('passes through templates without placeholders', () => {
    expect(fillPath('/self')).toBe('/self');
  });
});

describe('buildQuery', () => {
  it('returns empty string for empty query', () => {
    expect(buildQuery({})).toBe('');
    expect(buildQuery()).toBe('');
  });

  it('skips null and undefined', () => {
    expect(buildQuery({ a: 1, b: null, c: undefined })).toBe('?a=1');
  });

  it('repeats key for array values', () => {
    expect(buildQuery({ ids: [1, 2, 3] })).toBe('?ids=1&ids=2&ids=3');
  });

  it('url-encodes values', () => {
    expect(buildQuery({ q: 'hello world' })).toBe('?q=hello+world');
  });

  it('serialises booleans and numbers', () => {
    expect(buildQuery({ a: true, b: 0 })).toBe('?a=true&b=0');
  });
});

describe('buildUrl', () => {
  it('joins base+path+query correctly', () => {
    expect(
      buildUrl('https://api.avito.ru', '/items/{id}', { id: 1 }, { page: 2 }),
    ).toBe('https://api.avito.ru/items/1?page=2');
  });

  it('strips trailing slash from base', () => {
    expect(buildUrl('https://api.avito.ru/', '/self')).toBe('https://api.avito.ru/self');
  });

  it('adds leading slash to path if missing', () => {
    expect(buildUrl('https://api.avito.ru', 'self')).toBe('https://api.avito.ru/self');
  });
});
