# Roadmap

[Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/elchin92/avito-mcp/issues)

These are contribution directions, not delivery dates. Start with a concrete user task and a way to verify the result. Check existing issues before starting a substantial change.

## Good first contributions

| Task                  | Useful result                                                 | Validation                                                            |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------- |
| Verify a client setup | Exact config for a named client version and OS                | A successful connection and one read using fictional or redacted data |
| Improve a workflow    | A bounded seller task with prerequisites and expected output  | Reproducible fixture results and clear approval points                |
| Clarify an error      | Distinguish credentials, endpoint permissions and rate limits | A regression case and troubleshooting example                         |
| Improve a translation | Clear, equivalent EN/RU instructions                          | Run commands and check links in both versions                         |

## Larger improvements

| Area                     | Proposed outcome                                                                        | Requirements before release                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| OAuth provider migration | Optional dedicated identity provider; retain an upgrade path for existing installations | Issuer discovery, token compatibility, consent, deployment and rollback tests                |
| Narrower OAuth scopes    | Separate read and mutation permissions                                                  | Staged migration preserving existing `avito:mcp` tokens; [ADR 0005](docs/adr/0005-scopes.md) |
| Token storage            | Reduce exposure from a copied token-store file                                          | Migration and revocation tests; explicit backup and key-management model                     |
| Mutation audit           | Durable evidence for investigating uncertain or repeated actions                        | Secret redaction, bounded storage, concurrency and recovery tests                            |
| Spending limits          | Configurable limits for paid operations                                                 | Defined accounting across tools, refunds, concurrent processes and uncertain outcomes        |
| Agent evaluation         | Measure tool choice, pagination and approval behavior                                   | Fixed fixtures, explicit pass/fail criteria, recorded model/client versions                  |
| API coverage             | Add a demonstrated missing Avito workflow                                               | Official specification, shared tool factory, risk classification and contract tests          |

None of the proposed controls above should be treated as an implemented guarantee. The [security policy](SECURITY.md) and [conformance table](docs/conformance.md) describe the current boundaries.

**По-русски:** начните с подключения клиента, понятного сценария, перевода или диагностики ошибки. Крупные направления — внешний OAuth-провайдер, узкие права доступа, защита хранилища токенов, журнал операций и лимиты расходов. Для каждого изменения нужны задача пользователя, проверяемый результат и совместимый путь обновления; сроки здесь не обещаются.
