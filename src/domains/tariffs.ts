/**
 * Домен `tariffs` — swaggers/Тарифы.json (1 endpoint).
 * Read-only справочник тарифов в категории Транспорт.
 */
import type { DomainRegister } from '../core/tool-factory.js';
import { defineTool } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'tariffs_get_tariff_info',
    title: 'Тариф (Транспорт)',
    risk: 'read',
    description: 'Информация по тарифу в категории Транспорт.',
    method: 'GET',
    path: '/tariff/info/1',
    domain: 'tariff',
    input: {},
  });
};
