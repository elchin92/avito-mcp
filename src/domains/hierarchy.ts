/**
 * Домен `hierarchy` — swaggers/Иерархия Аккаунтов.json (5 endpoints).
 * Управление сотрудниками и привязкой объявлений к сотрудникам в иерархии аккаунтов.
 *
 * ⚠️ Write: linkItemsV1 — изменяет владельца объявлений (привязка к сотрудникам).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'hierarchy_check_ah_user_v1',
    title: 'Иерархия: статус пользователя',
    risk: 'read',
    description: 'Статус пользователя в Иерархии Аккаунтов (главный аккаунт / сотрудник / нет в иерархии).',
    method: 'GET',
    path: '/checkAhUserV1',
    domain: 'hierarchy',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'hierarchy_get_employees_v1',
    title: 'Иерархия: список сотрудников',
    risk: 'read',
    description: 'Список сотрудников в иерархии аккаунтов компании.',
    method: 'GET',
    path: '/getEmployeesV1',
    domain: 'hierarchy',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'hierarchy_list_company_phones_v1',
    title: 'Иерархия: телефоны компании',
    risk: 'read',
    description: 'Список телефонов компании с курсорной пагинацией.',
    method: 'GET',
    path: '/listCompanyPhonesV1',
    domain: 'hierarchy',
    input: {
      cursor: z.string().optional().describe('Курсор для следующей страницы (из предыдущего ответа).'),
    },
    queryParams: ['cursor'],
  });

  defineTool(server, ctx, {
    name: 'hierarchy_link_items_v1',
    title: '⚠️ Иерархия: привязать объявления',
    risk: 'write',
    description:
      '⚠️ ПЕРЕПРИВЯЗЫВАЕТ объявления к сотруднику (изменяет владельца). ' +
      'employeeId — ID сотрудника из hierarchy_get_employees_v1.',
    method: 'POST',
    path: '/linkItemsV1',
    domain: 'hierarchy',
    input: {
      employeeId: z.number().int().positive().describe('ID сотрудника в иерархии.'),
      itemIds: z.array(z.number().int().positive()).min(1).describe('ID объявлений для перепривязки.'),
    },
    body: { contentType: 'application/json', fields: ['employeeId', 'itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'hierarchy_list_items_by_employee_id_v1',
    title: 'Иерархия: объявления сотрудника',
    risk: 'read',
    description: 'Список объявлений конкретного сотрудника в категории (с курсорной пагинацией).',
    method: 'POST',
    path: '/listItemsByEmployeeIdV1',
    domain: 'hierarchy',
    input: {
      employeeId: z.number().int().positive().describe('ID сотрудника.'),
      categoryId: z.number().int().describe('ID категории Avito.'),
      lastItemId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('ID последнего объявления из предыдущей страницы (курсор).'),
    },
    body: {
      contentType: 'application/json',
      fields: ['employeeId', 'categoryId', 'lastItemId'],
    },
  });
};
