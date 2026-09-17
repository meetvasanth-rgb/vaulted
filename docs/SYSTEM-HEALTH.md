# Admin service health

`GET /api/admin/health` uses the same constant-time bearer-key verification and
failed-authentication throttling as the existing admin API. It returns no-store
responses and does not reveal connection strings, tokens, upstream exceptions,
customer records or message content.

The dashboard polls every 30 seconds while signed in. Concurrent tabs share an
in-flight check and a 30-second server cache. Checks run concurrently with a
four-second deadline. PostgreSQL also has a three-second query timeout;
HTTP and storage probes receive abort signals. No notifications are sent,
TURN credentials minted, or customer files read or written by probes.

Checks:
- Application: this instance responding, uptime, RSS memory and deployment SHA.
- PostgreSQL: SELECT 1.
- Redis: publisher PING plus publisher/subscriber readiness.
- Object storage: authenticated HEAD bucket. Requires bucket metadata access;
  failure may indicate credential permissions, not necessarily an outage.
- Cloudflare: fixed public status endpoint, cached five minutes, with fetch time.
  A provider incident does not necessarily affect this app.
- TURN, APNs, Firebase: configuration presence only, explicitly labelled as such.

A rolling maximum of 40 status transitions is held in process memory. Monitoring
starts when the dashboard is opened. It is not a durable incident log and is not
shared between replicas. Missing provider status is unknown rather than healthy.
Failed dashboard refreshes clear service cards and explicitly mark data stale.

Not included: independent uptime alerts, Railway account-wide status/CPU metrics,
live TURN relay tests, push delivery tests, or storage upload/download probes.
A complete server outage cannot be diagnosed from this same-server dashboard.
Deployment is required before the production admin page has these features.
