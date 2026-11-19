# Runbook RB-1 — Login page times out on slow network

Product: Northwind (web app). Symptom: on a slow 3G connection the login
page hangs for more than 30 seconds and eventually times out. Users report
"the login screen just hangs" or "I can't sign in".

## Known cause
The login page waits on a single blocking auth request with a 30-second
client timeout and no retry. On slow networks the request regularly exceeds
the timeout, and the stale session cookie from the failed attempt makes the
next attempt fail the same way.

## Fix (verified)
1. Raise the login request timeout from 30s to 45s.
2. Add one retry with exponential backoff (1s, then 2s) on timeout only.
3. Clear the stale session cookie before the retry so the second attempt
   starts clean.
4. Verify on a throttled 3G profile: login completes in under 20s.

## Do not
Do not tell the user to "try a faster network" — the fix is server-side.
Do not increase the timeout past 60s; the retry covers the rest.
