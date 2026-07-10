/**
 * `hierarchy` domain — swaggers/account-hierarchy.json (5 endpoints).
 * Management of employees and the assignment of listings to employees within the account hierarchy.
 *
 * ⚠️ Write: linkItemsV1 — changes the owner of listings (assignment to employees).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'hierarchy_check_ah_user_v1',
    title: 'Hierarchy: user status',
    risk: 'read',
    description:
      'Checks the status of the current user within the account hierarchy (check_ah_user). ' +
      'Returns the flags isCompany, isChief, isEmployee and avitoCompanyId — whether it is a company, a chief, an employee, and which company it is linked to. ' +
      'Read-only. Call before hierarchy_link_items_v1 to make sure the user belongs to a hierarchy and has the required role.',
    method: 'GET',
    path: '/checkAhUserV1',
    domain: 'hierarchy',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'hierarchy_get_employees_v1',
    title: 'Hierarchy: list of employees',
    risk: 'read',
    description:
      'Returns the list of account-hierarchy employees of the managing company (get_employees). ' +
      'For each employee it returns employeeId, name, email, phones and the chief flag (isChief). ' +
      'Read-only. Requires an active account-hierarchy plan; the employeeId returned here is used in hierarchy_link_items_v1 and hierarchy_list_items_by_employee_id_v1.',
    method: 'GET',
    path: '/getEmployeesV1',
    domain: 'hierarchy',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'hierarchy_list_company_phones_v1',
    title: 'Hierarchy: company phones',
    risk: 'read',
    description:
      'Returns the list of phone numbers of the managing company in the account hierarchy (list_company_phones) with cursor-based pagination. ' +
      'The response contains a phones array and a cursor for the next page (if no cursor is returned, the list has ended). ' +
      'Read-only. Requires an active account-hierarchy plan.',
    method: 'GET',
    path: '/listCompanyPhonesV1',
    domain: 'hierarchy',
    input: {
      cursor: z
        .string()
        .optional()
        .describe(
          'Cursor for fetching the next page; pass the cursor value from the previous response. Omit for the first page.',
        ),
    },
    queryParams: ['cursor'],
  });

  defineTool(server, ctx, {
    name: 'hierarchy_link_items_v1',
    title: '⚠️ Hierarchy: assign listings',
    risk: 'write',
    destructiveHint: true,
    description:
      'Assigns listings to an employee within the account hierarchy (link_items). Changes the ownership of listings inside the managing account: a repeated call reassigns them to a different employee. ' +
      'Irreversible operation (the previous assignment is not restored automatically); on success returns HTTP 204 with no body. ' +
      'Requires hierarchy permissions (the account-hierarchy plan); the user state can be checked via hierarchy_check_ah_user_v1, and the employeeId can be taken from hierarchy_get_employees_v1.',
    method: 'POST',
    path: '/linkItemsV1',
    domain: 'hierarchy',
    input: {
      employeeId: z
        .number()
        .int()
        .min(1)
        .describe('ID of the hierarchy employee the listings are assigned to (employeeId from hierarchy_get_employees_v1).'),
      itemIds: z
        .array(z.number().int().positive())
        .min(1)
        .max(50)
        .describe('List of Avito listing IDs to assign/reassign to the employee (from 1 to 50 elements).'),
    },
    body: { contentType: 'application/json', fields: ['employeeId', 'itemIds'] },
  });

  defineTool(server, ctx, {
    name: 'hierarchy_list_items_by_employee_id_v1',
    title: 'Hierarchy: employee listings',
    risk: 'read',
    description:
      'Returns the IDs of listings assigned to a specific hierarchy employee, filtered by category (list_items_by_employee). ' +
      'The response contains an items array and a hasNext flag for cursor-based pagination. Fetching listings for the company as a whole is not available — only per employee. ' +
      'Read-only. Requires hierarchy permissions; employeeId is taken from hierarchy_get_employees_v1.',
    method: 'POST',
    path: '/listItemsByEmployeeIdV1',
    domain: 'hierarchy',
    input: {
      employeeId: z
        .number()
        .int()
        .min(1)
        .describe('ID of the hierarchy employee whose listings are requested (employeeId from hierarchy_get_employees_v1).'),
      categoryId: z
        .number()
        .int()
        .min(1)
        .describe('Avito category ID for filtering the employee\'s listings.'),
      lastItemId: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'Pagination cursor: the ID of the last listing from the previous page. Omit for the first page; keep going while hasNext=true.',
        ),
    },
    body: {
      contentType: 'application/json',
      fields: ['employeeId', 'categoryId', 'lastItemId'],
    },
  });
};
