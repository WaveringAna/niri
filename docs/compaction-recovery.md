# compaction recovery

Use this when an active `[context summary v1]` node is malformed or contains a
transcript-like/meta response instead of a recollection.

The helper is dry-run by default. It reads the active session and immutable
SQLite context archive, reconstructs the failed node's input from its last good
parent plus direct archived sources, and calls the normal configured
summarizer. It does not mutate anything until `--apply` is supplied.

From this checkout, preview a production repair with:

```sh
./scripts/recover-prod-compaction.sh sum_32a42ede-78a6-46cb-b44d-4436f6b286fa
```

Apply it with:

```sh
./scripts/recover-prod-compaction.sh sum_32a42ede-78a6-46cb-b44d-4436f6b286fa --apply
```

The apply path stops `niri-harness.service`, backs up `session.json`,
`rest-snapshot.json`, `niri.db`, and any `niri.db-wal`/`niri.db-shm` sidecars
under `/home/niri/compaction-recovery-...`, then writes a new recovery summary
node. The malformed node is retained as immutable archive history, while the
active session bypasses it and keeps the current raw tail. The service is
restarted only if it was active before the repair, followed by health checks on
ports 4000, 4001, and 4002.

The wrapper streams the checked-out TypeScript helper over SSH, so the helper
does not need to be separately installed in production. Override the defaults
when needed:

```sh
NIRI_PROD_HOST=10.0.0.112 \
NIRI_PROD_USER=niri \
NIRI_PROD_HARNESS=/home/niri/harness \
./scripts/recover-prod-compaction.sh sum_... --apply
```

If the summary provider needs a smaller prompt, pass
`--max-transcript-chars 18000`; the helper otherwise waits for the configured
provider without imposing a short model timeout. Use `--no-restart` only when
you intentionally want to inspect the repaired files before bringing the
service back.
