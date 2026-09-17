# Account-history storage benchmarks

This benchmark isolates the rebuildable account-history serving database. It
measures deterministic construction, checkpoint validation, bounded page
queries, direct transaction-proof lookup, resident-memory change and database
space allocation. It is not a network-throughput claim.

Run the default workload:

```bash
npm run benchmark:history
```

Choose the number of history entries, transactions per synthetic block and
timed lookups:

```bash
npm run benchmark:history -- --entries 50000 --block-size 100 --lookups 500
```

The process creates a private temporary database, verifies its final checkpoint
and account root, executes both the previous point-query page algorithm and the
current bounded-range algorithm against the same data, prints JSON, and deletes
the temporary directory. Generated transactions have no monetary value and the
benchmark never opens a wallet or private key.

## 2026-09-17 reference run

Environment: Apple M1 with 8 GiB RAM, macOS 26.5.2, Node.js 26.0.0. Results are
single-host observations, not protocol limits.

| Metric | 10,000 entries | 50,000 entries |
| --- | ---: | ---: |
| Database bytes | 19,144,704 | 95,719,424 |
| Build time | 12.89 s | 64.46 s |
| Reopen time | 5.63 ms | 1.57 ms |
| Checkpoint and integrity validation | 273.86 ms | 734.27 ms |
| Previous page-of-20 p50 | 18.61 ms | 17.72 ms |
| Previous page-of-20 p95 | 31.63 ms | 24.84 ms |
| Bounded-range page-of-20 p50 | 6.76 ms | 6.06 ms |
| Bounded-range page-of-20 p95 | 12.20 ms | 11.09 ms |
| Transaction-proof lookup p50 | 0.13 ms | 0.13 ms |
| Transaction-proof lookup p95 | 0.31 ms | 0.20 ms |
| Measured RSS increase | 35.6 MB | 107.9 MB |
| Free database pages | 0 | 0 |

The page change replaces up to 640 point queries for a 20-entry proof page with
at most 32 primary-index range queries, one per Merkle level. On the larger run,
median page latency improved by 2.92 times and p95 latency by 2.24 times. Returned
proofs are still verified against the stored account commitment before leaving
the database layer.

Build time scales approximately linearly in this workload. Database size was
about 1.91 kB per history entry. Reopen itself remained constant-time at this
scale; the deliberate SQLite structural check and comparison with consensus
account commitments dominate validated startup.

## Compaction policy

The database exposes `storageStats()` with allocated bytes, free bytes, page
counts and reclaimable basis points. Both measured append-only databases had no
free pages. Automatic online compaction is therefore disabled: it would take an
exclusive database lock and rewrite healthy data without reclaiming space.

The safe policy is:

1. treat journals and consensus commitments as the recovery authority;
2. observe `storageStats()` rather than infer fragmentation from file size;
3. never compact while the node is serving or appending;
4. if a future schema creates material free space, rebuild into a separate file,
   verify every account commitment, and atomically replace the old cache using
   the existing rebuild path;
5. retain the old file until the replacement has been synchronized and checked.

No compaction trigger is added until a deletion-producing workload demonstrates
both meaningful reclaimable space and a safe operational window.

## Remaining measurements

- multi-million-entry runs on dedicated hosts;
- cold filesystem cache versus warm cache;
- mixed concurrent reads and finalized appends;
- power-loss injection during long rebuilds;
- storage behavior on the production filesystem and server hardware.
