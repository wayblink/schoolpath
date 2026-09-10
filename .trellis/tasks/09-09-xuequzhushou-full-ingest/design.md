# Design

Reuse ingest.sources, ingest.crawl_runs and ingest.extracted_records for immutable source snapshots and typed records. Retain all raw fields; derive lossless record keys from source path/index instead of school name alone. Source-only catalog schools and provisional committee relations use existing tables without changing public.schools facts.

Collect reachable same-origin pages and data references with timeouts, bounded traversal, content hashes and explicit failures. The homepage parser does not cover the map page: map JSON and MS_TIER must be captured independently. Keep whole JSON documents and queryable nested records. A whole document remains the authoritative fallback for unrecognized fields.

Default import is read-only planning. Authorized --apply uses transactions with record reconciliation before COMMIT. Exact same-district same-stage unique matches may link identities; ambiguous rows remain complete source records. Product district filtering remains in the existing query layer; /db is the full source inspection entry.

Rollback on any import or reconciliation error. Repeat batches reuse content identity and never reset accepted review states. Failed external files are recorded and are not synthesized.
