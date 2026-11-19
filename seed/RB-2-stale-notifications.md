# Runbook RB-2 — Stale notifications don't clear after being read

Product: Northwind (web app). Symptom: after marking a notification as
read, its badge count stays and the notification reappears in the list on
the next refresh.

## Known cause
The "mark as read" call updates the notification row but never clears the
cached badge count, and the list query reads the stale cache. The fix is a
one-line cache invalidation plus clearing the badge on the read receipt.

## Fix (verified)
1. In the mark-as-read handler, invalidate the badge-count cache key for
   the user immediately after the row update.
2. Clear the badge on the client as soon as the read receipt returns.
3. Verify: read a notification, refresh, badge is 0 and the item is gone
   from the unread list.

## Do not
Do not run a full cache flush — it drops every user's badge state.
