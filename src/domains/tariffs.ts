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
    description:
      'Возвращает информацию по тарифу аккаунта в категории Транспорт (tariffs_get_tariff_info, read-only). ' +
      'В ответе: текущий (current) и запланированный (scheduled) контракты — уровень тарифа, активность, даты начала/окончания (Unix time), бонусы, цена со скидкой и без, пакеты размещений с категориями, локациями, ценовыми группами и остатком. ' +
      'Используйте для проверки условий и остатка размещений. Параметров нет. ' +
      'Доступно только для тарифов категории «Транспорт» и не для тарифа «CPA»; иначе вернётся 404.',
    method: 'GET',
    path: '/tariff/info/1',
    domain: 'tariff',
    input: {},
  });
};
