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
    description:
      'Проверяет статус текущего пользователя в иерархии аккаунтов (check_ah_user). ' +
      'Возвращает флаги isCompany, isChief, isEmployee и avitoCompanyId — компания ли это, руководитель, сотрудник и к какой компании привязан. ' +
      'Только чтение. Вызывайте перед hierarchy_link_items_v1, чтобы убедиться, что пользователь состоит в иерархии и имеет нужную роль.',
    method: 'GET',
    path: '/checkAhUserV1',
    domain: 'hierarchy',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'hierarchy_get_employees_v1',
    title: 'Иерархия: список сотрудников',
    risk: 'read',
    description:
      'Возвращает список сотрудников иерархии аккаунтов управляющей компании (get_employees). ' +
      'По каждому сотруднику отдаёт employeeId, имя, email, телефоны и признак руководителя (isChief). ' +
      'Только чтение. Требует подключённого тарифа иерархии аккаунтов; employeeId отсюда используется в hierarchy_link_items_v1 и hierarchy_list_items_by_employee_id_v1.',
    method: 'GET',
    path: '/getEmployeesV1',
    domain: 'hierarchy',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'hierarchy_list_company_phones_v1',
    title: 'Иерархия: телефоны компании',
    risk: 'read',
    description:
      'Возвращает список телефонных номеров управляющей компании в иерархии аккаунтов (list_company_phones) с курсорной пагинацией. ' +
      'В ответе массив phones и cursor для следующей страницы (если cursor не вернулся — список закончился). ' +
      'Только чтение. Требует подключённого тарифа иерархии аккаунтов.',
    method: 'GET',
    path: '/listCompanyPhonesV1',
    domain: 'hierarchy',
    input: {
      cursor: z
        .string()
        .optional()
        .describe(
          'Курсор для получения следующей страницы; передайте значение cursor из предыдущего ответа. Для первой страницы не указывайте.',
        ),
    },
    queryParams: ['cursor'],
  });

  defineTool(server, ctx, {
    name: 'hierarchy_link_items_v1',
    title: '⚠️ Иерархия: привязать объявления',
    risk: 'write',
    destructiveHint: true,
    description:
      'Привязывает объявления к сотруднику в иерархии аккаунтов (link_items). Меняет принадлежность объявлений в рамках управляющего аккаунта: при повторном вызове перезакрепляет их за другим сотрудником. ' +
      'Необратимая операция (предыдущая привязка не восстанавливается автоматически), при успехе возвращает HTTP 204 без тела. ' +
      'Требует прав иерархии (тариф иерархии аккаунтов); состояние пользователя можно проверить через hierarchy_check_ah_user_v1, а employeeId взять из hierarchy_get_employees_v1.',
    method: 'POST',
    path: '/linkItemsV1',
    domain: 'hierarchy',
    input: {
      employeeId: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор сотрудника иерархии, к которому привязываются объявления (employeeId из hierarchy_get_employees_v1).'),
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .describe('Список идентификаторов объявлений Avito для привязки/перезакрепления за сотрудником (от 1 до 50 элементов).'),
    },
    body: { contentType: 'application/json', fields: ['employeeId', 'itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'hierarchy_list_items_by_employee_id_v1',
    title: 'Иерархия: объявления сотрудника',
    risk: 'read',
    description:
      'Возвращает идентификаторы объявлений, закреплённых за конкретным сотрудником иерархии, с фильтром по категории (list_items_by_employee). ' +
      'В ответе массив items и флаг hasNext для постраничного перебора по курсору. Получение объявлений по компании в целом недоступно — только по сотруднику. ' +
      'Только чтение. Требует прав иерархии; employeeId берётся из hierarchy_get_employees_v1.',
    method: 'POST',
    path: '/listItemsByEmployeeIdV1',
    domain: 'hierarchy',
    input: {
      employeeId: z
        .number()
        .int()
        .positive()
        .describe('Идентификатор сотрудника иерархии, чьи объявления запрашиваются (employeeId из hierarchy_get_employees_v1).'),
      categoryId: z
        .number()
        .int()
        .describe('Идентификатор категории Avito для фильтрации объявлений сотрудника.'),
      lastItemId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Курсор пагинации: идентификатор последнего объявления из предыдущей страницы. Для первой страницы не указывайте; продолжайте, пока hasNext=true.',
        ),
    },
    body: {
      contentType: 'application/json',
      fields: ['employeeId', 'categoryId', 'lastItemId'],
    },
  });
};
