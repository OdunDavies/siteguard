# SiteGuard hackathon evidence

This file distinguishes persisted or observed evidence from steps awaiting live verification. Do not replace pending fields with expected values.

| Item | Evidence | Status |
| --- | --- | --- |
| GitHub repository | https://github.com/OdunDavies/siteguard | Known repository |
| Production origin | https://siteguardxyz.vercel.app | Known origin; verify current deployment after the dashboard commit |
| Controlled demo and website | `76d6efef-9c99-4525-a165-22af42342f09` | Owner-scoped read verified on 2026-10-12 |
| Monitoring check | `8ca319ee-f018-4555-ad6e-061c2f7e7537` | Authenticated read showed unhealthy HTTP 503 |
| Incident | `9f79f90a-980b-42be-ac2c-51bf67900067` | Authenticated read showed open |
| Diagnosis run | `fccf0ffc-f592-49c1-89ec-f655719437d2` | Authenticated read showed diagnosed, medium confidence |
| Diagnosis trace ID | `425690d9478a12b43c36067340c63c76` | Stored in `agent_runs`; Neatlogs dashboard delivery unverified |
| Recovery authorization ID | Pending owner approval | No grant was present at the last owner-scoped read |
| Recovery run ID | Pending | No recovery was executed at the last read |
| Recovery attempt ID | Pending | No recovery attempt was present at the last read |
| Recovery verification check | Pending | Requires a live authorized recovery |
| Recovery trace ID and Neatlogs link | Pending | Requires actual run and dashboard readback |
| Entire checkpoint ID | Pending | `entire checkpoint list` reported zero local checkpoints on `main`; `entire doctor` reported Git hooks not installed and Codex hook discovery unresolved due worktree path access denial |

## Evidence limitations

The earlier connection-error check predates the corrected monitoring transport. The diagnosis cited it as a possible network issue, but it does not independently establish a network outage. The controlled recovery verifier reads persistent demo state and links a fresh verification check; the dashboard also requests the public health URL after a recovery request to display its actual HTTP status. No live recovery result should be claimed until the owner grants permission and the action completes.
