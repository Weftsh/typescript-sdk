# Changelog

## 0.1.0

First release.

- `Weft` client: create, find, list, batch-create and batch-delete repositories;
  mirrors; tokens.
- `Repo`: commits through a builder (`createCommit().put().delete().send()`)
  with optimistic concurrency and an audit `context`; file, tree, history and
  diff reads with ETag caching; branches and tags; `reset` and `revert`;
  repository-scoped git remote URLs; webhooks; bundle export.
- `verifyWebhook` for `X-Weft-Signature-256` deliveries, on Web Crypto.
- `WeftError` and `WeftConflictError` (with `currentTip`).
