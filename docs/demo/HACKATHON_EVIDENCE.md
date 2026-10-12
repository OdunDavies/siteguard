# SiteGuard hackathon evidence

This file distinguishes persisted or observed evidence from steps awaiting live verification. Do not replace pending fields with expected values.

| Item | Evidence | Status |
| --- | --- | --- |
| GitHub repository | https://github.com/OdunDavies/siteguard | Known repository |
| Production origin | https://siteguardxyz.vercel.app | Vercel production deployment of commit `e999721` reported Ready |
| Controlled demo and website | `76d6efef-9c99-4525-a165-22af42342f09` | Owner-scoped read verified on 2026-10-12 |
| Monitoring check | `8ca319ee-f018-4555-ad6e-061c2f7e7537` | Authenticated read showed unhealthy HTTP 503 |
| Incident | `9f79f90a-980b-42be-ac2c-51bf67900067` | Owner-scoped read showed `recovered` at 2026-10-12 14:58:25 UTC |
| Diagnosis run | `fccf0ffc-f592-49c1-89ec-f655719437d2` | Authenticated read showed diagnosed, medium confidence |
| Diagnosis trace ID | `425690d9478a12b43c36067340c63c76` | Stored in `agent_runs`; Neatlogs dashboard delivery unverified |
| Recovery authorization ID | `4bf0e3a1-e83b-4aaa-9687-a6b0434730f4` | Owner-approved `reset_demo_service` on this demo; one permitted use, one used |
| Recovery run ID | `f526dde5-d1cb-4642-85c8-90dd6e3addcf` | `recovered`; action `reset_demo_service`; authorization decision `allowed` |
| Recovery attempt ID | `145c7c18-6548-42de-9b15-d293a545890a` | `succeeded`, result `RESET_APPLIED`, linked to grant and run |
| Recovery verification check | `01cafb26-7820-4b76-9b90-b8096a554a7d` | Persisted healthy, HTTP 200; linked to attempt and incident |
| Public health endpoint after recovery | https://siteguardxyz.vercel.app/api/demo/health/76d6efef-9c99-4525-a165-22af42342f09 | Separate read-only GET returned HTTP 200 and `{"status":"healthy"}` |
| Recovery trace ID | `563353a6c892113adc04f685dc595191` | Stored in `agent_runs`; Neatlogs dashboard delivery unverified |
| Recovery audit events | Grant `f8137f74-8f8e-449f-aeeb-e4ec62e8f677`; authorized `08c1093b-1202-487b-a2e7-63121895f134`; executed `16b45094-34f6-47da-8415-4b52d928cbb8`; verified `9d052dbb-ceda-465b-a3c1-5e518f7081f0` | Owner-scoped reads found the events; the last three correlate to the attempt and run |
| Entire checkpoint ID | Pending | `entire checkpoint list` reported zero local checkpoints on `main`; `entire doctor` reported Git hooks not installed and Codex hook discovery unresolved due worktree path access denial |

## Evidence limitations

The earlier connection-error check predates the corrected monitoring transport. The diagnosis cited it as a possible network issue, but it does not independently establish a network outage. The controlled recovery verifier reads persistent demo state and links a fresh verification check; the dashboard also requests the public health URL after a recovery request to display its actual HTTP status. The owner performed the two separate in-app approval and execution steps before the live recovery evidence above was collected. Stored Neatlogs trace IDs do not establish that traces are visible in the Neatlogs dashboard.
