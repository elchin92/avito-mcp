/**
 * `tariffs` domain — swaggers/tariffs.json (1 endpoint).
 * Read-only reference for tariffs in the Transport category.
 */
import type { DomainRegister } from '../core/tool-factory.js';
import { defineTool } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'tariffs_get_tariff_info',
    title: 'Tariff (Transport)',
    risk: 'read',
    description:
      'Returns the account tariff information for the Transport category (tariffs_get_tariff_info, read-only). ' +
      'The response includes the current and scheduled contracts — tariff level, activity status, start/end dates (Unix time), bonuses, prices with and without discount, and listing packages with their categories, locations, price groups, and remaining balance. ' +
      'Use it to check tariff terms and the remaining listing balance. Takes no parameters. ' +
      'Available only for tariffs in the "Transport" category and not for the "CPA" tariff; otherwise it returns 404.',
    method: 'GET',
    path: '/tariff/info/1',
    domain: 'tariff',
    input: {},
  });
};
