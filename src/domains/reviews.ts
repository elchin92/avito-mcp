/**
 * `reviews` domain — swaggers/reviews.json (4 endpoints).
 *
 * ⚠️ Write: create_review_answer, remove_review_answer — public actions (visible to customers).
 */
import { z } from 'zod';

import { defineTool, type DomainRegister } from '../core/tool-factory.js';

export const register: DomainRegister = (server, ctx) => {
  defineTool(server, ctx, {
    name: 'reviews_get_ratings_info_v1',
    title: 'User rating',
    risk: 'read',
    description:
      'Returns the aggregated rating of the current user (reviews_get_ratings_info_v1): average score, the total number of active reviews and the number of reviews that affect the rating, plus a flag indicating whether the rating is enabled. Takes no parameters and returns no paginated data. To get the list of reviews itself, use reviews_get_reviews_v1.',
    method: 'GET',
    path: '/ratings/v1/info',
    domain: 'ratings',
    input: {},
  });

  defineTool(server, ctx, {
    name: 'reviews_get_reviews_v1',
    title: 'Reviews list',
    risk: 'read',
    description:
      'Returns a paginated list of active reviews for the current user (reviews_get_reviews_v1): review id, score, text, author, listing, attached photos and the current seller answer, plus total — the overall number of reviews. Use it to browse individual reviews and obtain the reviewId (required for reviews_create_review_answer_v1). If you only need the aggregate score without the list, use reviews_get_ratings_info_v1.',
    method: 'GET',
    path: '/ratings/v1/reviews',
    domain: 'ratings',
    input: {
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Pagination offset: how many reviews to skip from the start of the list. Defaults to 0; increase by the limit value to fetch the next page.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of reviews per page. API-allowed range: 1–50 (defaults to the upper bound).'),
    },
    queryParams: ['offset', 'limit'],
  });

  defineTool(server, ctx, {
    name: 'reviews_create_review_answer_v1',
    title: '⚠️ Reply to a review',
    risk: 'public',
    description:
      'Publishes a seller answer to a review (reviews_create_review_answer_v1). WARNING: the answer is PUBLIC — once moderated it is visible to everyone on the profile page. Requires reviewId (from reviews_get_reviews_v1) and the message text; returns the id of the created answer and a timestamp. Confirm the action with the user. To delete an answer, use reviews_remove_review_answer_v1.',
    method: 'POST',
    path: '/ratings/v1/answers',
    domain: 'ratings',
    input: {
      reviewId: z
        .number()
        .int()
        .positive()
        .describe('ID of the review the answer is published for. Taken from the id field in reviews_get_reviews_v1.'),
      message: z
        .string()
        .min(1)
        .describe('Text of the public answer to the review (must not be empty). Goes through moderation before publication.'),
    },
    body: { contentType: 'application/json', fields: ['reviewId', 'message'] },
  });

  defineTool(server, ctx, {
    name: 'reviews_remove_review_answer_v1',
    title: '⚠️ Delete a review answer',
    risk: 'public',
    destructiveHint: true,
    description:
      'Permanently deletes a previously published seller answer to a review (reviews_remove_review_answer_v1). WARNING: deletion is IRREVERSIBLE and immediately removes the public answer from the profile; returns a success flag. Confirm the action with the user. To publish an answer again, use reviews_create_review_answer_v1.',
    method: 'DELETE',
    path: '/ratings/v1/answers/{answer_id}',
    domain: 'ratings',
    input: {
      answer_id: z
        .number()
        .int()
        .positive()
        .describe('ID of the review answer to delete (not to be confused with reviewId). Taken from the answer.id field of a review in reviews_get_reviews_v1.'),
    },
    pathParams: ['answer_id'],
  });
};
