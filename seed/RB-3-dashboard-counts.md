# Runbook RB-3 — Dashboard counts don't refresh after changing filters

Product: Northwind (web app). Symptom: changing a dashboard filter leaves
the old counts on screen until a full page reload.

## Known cause
Dashboard counts are cached under a key that does not include the active
filter values, so a filter change still serves the previous counts.

## Fix (verified)
1. Include the filter values in the dashboard cache key.
2. Invalidate the key when a filter changes.
3. Verify: change a filter, counts update within 2 seconds without reload.

## Do not
Do not disable the dashboard cache — it exists because the counts query is
expensive.
