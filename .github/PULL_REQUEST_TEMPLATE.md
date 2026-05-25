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

- [ ] `npm run lint` — без ошибок
- [ ] `npx tsc --noEmit` — типы валидны
- [ ] `npm run build` — собирается
- [ ] `npm test` — все тесты зелёные
- [ ] Обновил `CHANGELOG.md` (если изменение видно пользователю)
- [ ] Нет реальных credentials, токенов, item-IDs, бизнес-данных в коде / тестах / примерах
- [ ] Если добавлен новый swagger — есть запись в `src/meta/domain-registry.ts` и описания на русском
- [ ] Каждый новый tool имеет явный `risk` (`'read'` / `'write'` / `'money'` / `'public'`) — см. [CONTRIBUTING.md](../CONTRIBUTING.md#conventions). Кастомные tools через `server.registerTool` напрямую — реализуют свой safe-mode guard.

## Notes for reviewer / Заметки для ревьюера

<!-- Что-то нестандартное? Trade-offs? Open questions? -->
