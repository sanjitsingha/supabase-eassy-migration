# 🚀 Nebkern Migration Tool

::: {align="center"}
![GitHub
stars](https://img.shields.io/github/stars/your-org/nebkern-migration-tool?style=for-the-badge)
![GitHub
license](https://img.shields.io/github/license/your-org/nebkern-migration-tool?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=nextdotjs)
![Supabase](https://img.shields.io/badge/Supabase-Compatible-3ECF8E?style=for-the-badge&logo=supabase)

**Zero-downtime, resumable Supabase migration engine**\
_Migrate schema, data, auth, storage and Edge Functions across Supabase
environments._
:::

---

## ✨ Features

- 🔄 Cloud ↔ Cloud
- 🖥️ Cloud ↔ Self-hosted
- 📦 Self-hosted ↔ Self-hosted
- ♻️ Crash-safe resumable migrations
- 🚀 Parallel data transfer
- 🔒 Secure in-memory credential vault
- 📊 Automatic validation reports
- ⚡ Multiple SQL transports

## 🏗️ Architecture

```text
        Source
           │
     ┌─────▼─────┐
     │ Discovery │
     └─────┬─────┘
           │
 ┌─────────▼─────────┐
 │ DDL │ Data │ Auth │
 └─────────┬─────────┘
           │
    Validation & Report
           │
      Destination
```

## 🚀 Quick Start

```bash
npm install
npm run dev
npm run check
```

## 🎯 Why this project?

Unlike traditional migration tools:

✅ Nebkern ❌ Traditional

---

No pg_dump dependency Version locked
Keyset pagination OFFSET pagination
Crash-safe resume Restart from scratch
Multiple SQL transports Single transport
Parallel execution Mostly sequential

## 🧩 SQL Transport Layer

Transport Cloud Self-hosted

---

Management API ✅ ❌
RPC ✅ ✅
Direct PostgreSQL ✅ ✅

## 🔐 Security

- AES-256-GCM encrypted secrets
- No credentials stored on disk
- Automatic key expiry
- Resume without losing checkpoints

## 📂 Project Structure

```text
src/
 ├── core/
 ├── app/
 ├── components/
 └── scripts/
```

## 🧪 Verification

```bash
npm run verify
npm run verify:migration
npm run verify:resume
npm run verify:connection
npm run verify:database
```

## 🚢 Deployment

Nebkern is a **long-running process**, not a request/response API. A migration keeps executing in server memory after the HTTP call that started it returns — the runner registry, the credential vault, and the SSE event bus all live in one process's heap, and job/log state is written to a local `.nebkern/` folder on disk.

| Target | Works? | Why |
|---|---|---|
| VPS / bare metal (`npm run build && npm run start`) | ✅ | Persistent process — this is the intended target |
| Docker container | ✅ | Same, as long as the container stays up and `.nebkern/` is a persistent volume |
| Railway, Fly.io, Render | ✅ | Persistent process, not function-per-request |
| **Vercel serverless functions** | ❌ | Functions freeze once the response is sent — a started migration stops executing within seconds. `maxDuration` does not fix this; it only bounds how long a *single request* may run |
| Any FaaS platform (AWS Lambda, Cloud Functions, etc.) | ❌ | Same reason: no persistent process to run the migration in |

If you saw a `maxDuration` build error on Vercel, that error is now fixed — every route is capped at 300s, the platform ceiling. But fixing it does not make migrations survive on serverless: the underlying execution model still needs a process that keeps running. Deploy to one of the ✅ targets above instead.

## ⚠️ Known Limitations

- Edge Functions auto-deployment is Cloud-only
- FDW objects are not migrated
- Range types currently skipped
- Requires a persistent host — see [Deployment](#-deployment). Not compatible with serverless/FaaS platforms

---

::: {align="center"}

### ⭐ Built with Next.js 16 • TypeScript • Supabase

If this project helps you, consider giving it a ⭐ on GitHub.
:::
