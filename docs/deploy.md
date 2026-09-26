# Deploying EXPOSURE

Production runs the same `next start` server as local development, so live x-rays, the disk cache, the
call ledger and the credit guard behave exactly as they do on a laptop. The stack is two containers:
the app and [Caddy](https://caddyserver.com) in front of it (HTTPS, compression, security headers and
the visitor IP used by the per-visitor limits).

Why a server rather than a serverless platform: the credit guard, the Nansen response cache and the
recorded scans live on disk and must be shared by every request. Serverless platforms run many
short-lived copies without a shared disk, which would make the daily credit cap unreliable.

## 1. A fresh Ubuntu 24.04 server

Any small VPS works (2 vCPU / 4 GB is plenty). From a checkout of this repo:

```bash
ssh root@SERVER 'bash -s' < scripts/server-setup.sh
```

It installs Docker from Docker's repository, allows only SSH/HTTP/HTTPS through the firewall, turns off
SSH passwords, enables automatic security updates and fail2ban, adds swap and clones the app to
`/opt/exposure`.

## 2. Secrets

Create `/opt/exposure/.env.production` on the server (`chmod 600`). It is never committed.

```bash
NANSEN_API_KEY=your-key
EXPOSURE_LIVE=1                 # allow live x-rays on the production server
EXPOSURE_DAILY_CREDITS=80       # all live scans together, per UTC day
EXPOSURE_DEEP_DAILY_CREDITS=50  # the deep tier's share of that budget
EXPOSURE_CREDIT_FLOOR=400       # live scans stop when the account falls below this
```

See `.env.example` for every option.

## 3. Start

```bash
cd /opt/exposure && docker compose up -d --build
```

Without a domain the site is served over HTTP on the server's IP. With a domain, point its DNS at the
server and put the Caddy settings in `/opt/exposure/.env` (read by Docker Compose, never committed), then
restart so Caddy fetches a certificate:

```bash
echo 'SITE_ADDRESS="exposure.example, www.exposure.example"' > /opt/exposure/.env
docker compose up -d
```

`www.` redirects to the bare domain.

Behind Cloudflare's proxy, also pass Cloudflare's IP ranges
(https://www.cloudflare.com/ips/) as `TRUSTED_PROXIES` (space separated) so the per-visitor limits see the
real visitor, and use SSL mode "Full (strict)".

## 4. Update

```bash
cd /opt/exposure && git pull && docker compose up -d --build
```

## Operations

- Logs: `docker compose logs -f app`
- Credits used today and the account balance: `curl -s http://localhost/api/account` on the server
- Nansen calls made by the server: `/opt/exposure/data/ledger/calls.ndjson`
- Everything the app stores is under `/opt/exposure/data`; deleting `data/cache` only costs credits on
  the next scans.
