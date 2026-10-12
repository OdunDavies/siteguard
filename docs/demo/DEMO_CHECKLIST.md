# SiteGuard live demo checklist

## Before recording

- [ ] Confirm the intended GitHub commit is deployed and Vercel reports Ready.
- [ ] Sign in as the disposable owner at the production `/login` page. Never display credentials or tokens.
- [ ] Confirm `/dashboard` loads owner-scoped records and the demo service ID is `76d6efef-9c99-4525-a165-22af42342f09`.
- [ ] Confirm the controlled health URL matches the monitored website URL and `MONITOR_ALLOWLIST_HOSTS` contains only the exact production host.
- [ ] Confirm the demo is healthy (HTTP 200) before recording a fresh healthy-to-failed cycle. The currently documented fixture is failed; restoring it requires a separate, explicit owner grant and recovery.
- [ ] Check the configured model, Supabase server credential, Neatlogs key, demo origin, and public Supabase key exist in Vercel without displaying their values.
- [ ] Allow at least 30 seconds between manual checks. Two failed checks are needed for the current demo failure threshold.
- [ ] Ensure the browser has enough time for the bounded diagnosis and recovery requests. Do not refresh mid-request.
- [ ] Review any existing active recovery grant. The dashboard requests a new one-use, 15-minute grant only when no usable grant is active.

## During recording

- [ ] Show real overview metrics, website status, and last check.
- [ ] Simulate failure only on the owned controlled demo.
- [ ] Run monitoring until an incident actually appears.
- [ ] Run diagnosis and show persisted evidence with uncertainty stated plainly.
- [ ] Click **Authorize recovery** and confirm; verify the grant appears before running recovery.
- [ ] Click **Run AI recovery** and confirm; record the returned outcome.
- [ ] Verify the public health endpoint is HTTP 200, the attempt has a verification check, and the incident has the documented resolved state.
- [ ] Record the new run, attempt, verification check, trace ID, and audit event IDs in `HACKATHON_EVIDENCE.md` only after verification.

## If something fails

- [ ] Use **Refresh status** to inspect persisted state before retrying a request.
- [ ] Respect monitoring cooldown and recovery attempt limits; do not repeatedly click while a request is pending.
- [ ] If a recovery outcome is unknown, inspect the attempt and health state rather than replaying the action.
- [ ] Do not grant broad credentials, bypass owner checks, or manually edit incident records to make a demonstration appear successful.

## After recording

- [ ] Check whether the recovery trace is visible in Neatlogs; a stored trace ID alone is not delivery proof.
- [ ] Check Entire checkpoint state and record only checkpoint IDs the CLI actually reports.
- [ ] Remove or revoke any still-active demo recovery grant through the owner-scoped API if it is no longer needed.
