# Tenant hierarchy, robo campaigns, and reporting policy

## Tenant permissions

- `superadmin` is platform-wide and can create, edit, activate/deactivate, and delete any tenant. It can inspect every tenant and every report.
- A normal tenant admin manages only its own tenant.
- A reseller tenant admin can create and manage only direct child tenants. The child tenant is created as `normal` and cannot create another child unless Superadmin promotes it to `reseller`.
- A reseller admin can switch into only its own tenant or direct children. The server validates `as_tenant` on every request; URLs are never trusted.
- A child tenant admin manages only the child tenant's users, queues, IVR, campaigns, DIDs, trunks, and reports.
- Managers do not receive tenant lifecycle permissions. User Managers do not receive tenant or telephony permissions. Reports Only receives read/export reporting permissions.

## Robo IVR blast and survey campaigns

`robo_agent_schema.sql` extends campaigns with `is_robo_campaign`, `voice_blast`, and `robo_survey` modes. Campaign voice content supports uploaded audio, TTS, DTMF answers, branching, and captured survey responses. The robo runtime is started with:

```bash
npm run robo-runtime
```

Refresh the robo materialized views after ingestion:

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_robo_campaign_hourly;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_survey_response_summary;
```

The reports panel should use `mv_robo_campaign_hourly` for attempts, connections, failures, busy calls, likely hangups, average message duration, and captured answers. Survey panels should use `survey_responses`/`mv_survey_response_summary` for question-level DTMF distributions.

## Required report panels

MIS should expose Agent Activity, Queue SLA, DID, Campaign, IVR Journey, Recordings, Login/Logout, Robo Campaign, and Survey Response panels. All queries must include the authenticated tenant scope; Superadmin may use an explicit tenant filter when viewing platform-wide data.
