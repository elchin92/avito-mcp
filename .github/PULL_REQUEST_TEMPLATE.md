<!--
Спасибо за PR! / Thanks for the PR!
Пожалуйста, заполните секции ниже. / Please fill in the sections below.
-->

## What & why / Что и зачем

<!-- 1-3 предложения: что меняется и зачем. Если фиксит issue — "Fixes #123". -->

## Type of change

- [ ] Bug fix (не ломает существующее поведение)
- [ ] New Avito domain / tool (новый swagger или новый endpoint)
- [ ] Tool description improvement (улучшение описаний для LLM)
- [ ] Docs only (README / CHANGELOG / CONTRIBUTING)
- [ ] Refactor / internal change (без изменения публичного API)
- [ ] Breaking change (ломает обратную совместимость — опишите миграцию)

## Checklist

- [ ] Code changes: `npm run verify:release` passes; relevant behavior is covered by meaningful tests.
- [ ] Docs/examples: client format, internal links and EN/RU guidance are consistent.
- [ ] Updated `CHANGELOG.md` for user-visible changes.
- [ ] No real credentials, tokens, customer data or business identifiers in code, tests or examples.
- [ ] New domains are registered in `src/meta/domain-registry.ts`; tool titles and descriptions are in English.
- [ ] New tools have an explicit `risk` (`read`, `write`, `money`, `public`, or `sensitive`).
- [ ] Business tools use `defineTool`, including custom execution, so policy, confirmation, dry-run, idempotency and error handling stay shared. See [CONTRIBUTING](../CONTRIBUTING.md#conventions).

## Notes for reviewer / Заметки для ревьюера

<!-- Что-то нестандартное? Trade-offs? Open questions? -->
