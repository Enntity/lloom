# Web mission control

Open the host's web address (normally `http://127.0.0.1:8787`) and connect with an
operator or agent credential. You can paste the token or choose its file. The
page keeps credentials, message drafts, and session content in memory. Reloading
or disconnecting requires connecting again. Only appearance and pinned session
addresses are saved in browser storage.

The dashboard runs directly from Accord. It needs no Tessera installation, cloud
account, frontend build, external fonts, or JavaScript runtime dependencies.

## Find and steer work

- **Overview** brings questions, active sessions, jobs, resources, and host status
  together. Pinned sessions stay near the top.
- **Needs you** collects operator questions, overseer check-ins, and sessions that
  are waiting, blocked, or failed. Choose a suggested answer or write one. Answers
  are saved for the asking agent; dismissing a question does not answer it.
- **Sessions** filters by source and state. Search covers session summaries and
  recorded activity on linked hosts, plus participant names and declared work.
  Open a session to read its activity, message it, copy its address, or snooze
  local overseer checks for an hour when authorized.
- **Resources** shows ownership, unfinished recovery, and local queued work. Host
  telemetry and machine metadata are fetched directly on demand. Select a linked
  host to inspect its sample. Operator actions can pause new admissions or cancel
  a local task; the existing driver still controls recovery and ownership transfer.
- **Messages** contains the connected principal's inbox. Replies can cross linked
  hosts. Marking a message read acknowledges this inbox delivery. Sent messages
  remain visible in this tab; check their delivery status explicitly. Delivered
  means delivered to the recipient's inbox, not read or acted upon.
- **Activity** shows coordinator events with expandable details.

Questions remain local to their asking host's operator inbox. To answer a question
on another host, connect to that host's dashboard. An agent credential cannot see
or answer all operator questions.

## Browser behavior

The layout adapts from desktop to phone width, supports system/light/dark themes,
keyboard focus, reduced motion, semantic controls, and a navigation drawer on
small screens. Use `Cmd/Ctrl K` or `/` to search, `N` to compose, `Cmd/Ctrl Enter`
to send, `?` for shortcuts, and `Escape` to close a panel.

The page refreshes coordination observations every five seconds while visible and
less often when hidden. Answer drafts survive refreshes. Telemetry is read only
while its view is open, with a roughly fifteen-second refresh interval. Background
tabs can be throttled by the browser; this is not a real-time alarm guarantee.

Browser notifications are opt-in and feature-detected. New questions and overseer
incidents can produce a generic notification while the tab is running. The tab
title also shows the attention count. There is no closed-tab push service or
service worker. Notification permission, clipboard support, and native dialogs
have explicit fallbacks. The target is modern Safari, Firefox, and Chromium;
Internet Explorer is not supported. Recorded browser qualification names the
actual engine/surface tested rather than claiming a full device matrix.

## Failure and privacy behavior

A missing host, failed driver observation, or unavailable telemetry never means
free capacity. Previously known assets on an unreachable linked host remain
visible as unknown. Local connection loss marks displayed state stale and disables
shared-state mutations. The host's reservation and recovery rules remain decisive.

Mutation retries retain their idempotency key after an uncertain response. Changing
an unconfirmed request's contents is rejected. Private session content is cleared
when a fresh observation reports privacy; disconnect clears tab-held content and
credentials. Previously received content cannot be retroactively recalled from a
browser that is offline. All agent-supplied content is rendered as text, under the
host's same-origin Content Security Policy.

Use an SSH forward for remote access. This UI does not expose the loopback service
to the public network or relax authentication.
