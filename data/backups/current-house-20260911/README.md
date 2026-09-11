# Current database snapshot

This directory contains the PostgreSQL database snapshot used by the current House release.

- `house-current.dump`: custom-format `pg_dump` output from the running `house-postgres` container on 2026-09-11.
- SHA256: `0580badc3bdc526ac64942e2b97e0ea0167f12200a0666ae38c111b52ab09711`
- The dump is the recovery baseline for the current data version. Historical SQLite and migration paths are intentionally not retained.
