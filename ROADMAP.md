# Roadmap / Задачи для участников

[README](README.md) · [Contributing](CONTRIBUTING.md)

These are contribution directions, not delivery commitments. Start an issue with the user task, expected behavior and validation before a substantial implementation. Check existing issues first to avoid duplicate work.

| Contribution                       | A useful first result                                                                    | How to validate                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Verify client setup                | Record client/version, OS and one successful read using an existing example              | Redacted connection log and exact config changes; no real credentials                      |
| Improve seller recipes             | Add one bounded task with its required profile, prompt and expected output               | Run against a test fixture; clearly label any separate live-account check                  |
| Add an omitted API domain          | Pick one official Avito OpenAPI specification linked from an issue                       | Factory-based tools, contract tests, risk classification and a reproducible user task      |
| Improve account-access diagnostics | Help distinguish valid credentials from missing endpoint permissions                     | Regression test for the relevant error and a troubleshooting example                       |
| Check real agent behavior          | Add an evaluation for tool choice, pagination, approval boundaries or incomplete reports | Fixed fixtures and explicit pass/fail criteria; report model/client versions when relevant |

For small first contributions, check a client example, translate a recipe, or improve a confusing error explanation. New features should solve a demonstrated task; adding tools alone is not the objective.

**По-русски:** полезные первые задачи — проверить подключение своего клиента, улучшить сценарий продавца, добавить конкретный отсутствующий API по официальной спецификации, уточнить диагностику прав или проверить поведение агента на фиксированных данных. Для большой правки сначала создайте issue с задачей пользователя и способом проверки. Сроки реализации здесь не обещаются.
