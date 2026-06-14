# AI Insights Sharing Server

Self-hosted remote sharing for AI Insights dashboard snapshots.

This replaces fragile WSL/LAN sharing with a normal backend flow:

```text
VS Code extension -> POST /api/snapshots -> sharing server
phone/browser     -> GET /dashboard/:id  -> sharing server
```

## Run Locally

```bash
cd sharing-server
BASE_URL=http://localhost:3000 npm start
```

## Run With Docker

```bash
cd sharing-server
BASE_URL=https://ai-insights.example.com docker compose up -d
```

For a phone outside your machine, expose this server with a real host name or LAN-reachable
host, then set:

```json
{
  "aiInsights.sharing.mode": "teamServer",
  "aiInsights.sharing.teamServer.endpointUrl": "https://ai-insights.example.com"
}
```

## Authentication

Uploads require:

```text
Authorization: Bearer <GitHub OAuth token>
```

The server validates the token with GitHub. Optionally restrict uploads to an organization:

```bash
ALLOWED_GITHUB_ORG=my-org
```

Snapshots are public but unguessable by id and expire after `SNAPSHOT_TTL_HOURS`
hours, default `72`.

## Endpoints

- `GET /health`
- `POST /api/snapshots`
- `GET /dashboard/:snapshotId`
