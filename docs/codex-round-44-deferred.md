# Codex round-44 — deferred findings

Applied findings are in the round-44 commit. These four are real but deferred:

- **#7/#8 withFileLock reclaim atomicity + pid-reuse ownership.** The compare-then-unlink reclaim has a TOCTOU window (reproduced) and pid liveness can bless a recycled pid. Practical exposure is small (5s stale window, same-user single-machine, strict mode on all registry writers); a real fix is an fd-scoped flock primitive — worth doing as its own change with a soak test.
- **#9 drive ctrl-c leaks the in-flight writer call.** Bounded cost (read-only, 1 turn, $1 cap) once per interrupt; fix needs an abort handle threaded through runAgent.
- **swift#2 no way to cancel a pending gentle-connect.** The wait is intentional (never interrupts); a cancel affordance (ghost adopt --cancel <tty>) is queued.
- **swift#8 'started' = alive after 400ms.** A registry-confirmed handshake would close the last false-positive window on the goal panel's success path.
