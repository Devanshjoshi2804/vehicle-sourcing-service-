# Deploying vehicle-sourcing-service to OVH

A single small OVH Public Cloud instance running `docker compose`: **Postgres +
the API + Caddy** (auto-TLS). Caddy gives a public HTTPS URL, which is what
ElevenLabs needs to call the webhooks.

This service is standalone — it does **not** join the big platform `infra/`
compose stack. Deploy it on its own instance (or alongside, on its own ports).

## 0. What you need

- An OVH Public Cloud instance (smallest is fine: 2 vCPU / 4 GB, Debian 12).
- A public DNS name pointing at the instance's IP. Either:
  - a subdomain you own, e.g. `sourcing.pinified.com` → instance IP, **or**
  - zero-config: `<instance-ip-with-dashes>.sslip.io` (e.g. `51-222-13-9.sslip.io`)
    resolves to that IP automatically — good enough for a valid Let's Encrypt cert.
- Ports **80 and 443** open to the internet (OVH security group). Keep 5432 closed.

## 1. Provision the instance — [OVH console]

1. Public Cloud → Instances → Create. Debian 12, smallest flavor, your SSH key.
2. Security group / firewall: allow inbound **22, 80, 443**. Do NOT expose 5432.
3. Note the public IPv4.
4. (If using a real subdomain) add a DNS **A record** → that IP.

## 2. Install Docker on the instance — [SSH]

```bash
ssh debian@<INSTANCE_IP>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

## 3. Get the code + configure

```bash
git clone https://github.com/Devanshjoshi2804/vehicle-sourcing-service-.git
cd vehicle-sourcing-service-
cp .env.example .env
nano .env
```

Set in `.env`:

```
PG_PASSWORD=<a strong password>
PUBLIC_DOMAIN=sourcing.pinified.com        # or 51-222-13-9.sslip.io
PUBLIC_BASE_URL=https://sourcing.pinified.com
API_KEY=<dispatcher api key>
WEBHOOK_SECRET=<shared secret for EL webhooks>
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_AGENT_SOURCING=agent_...        # after agent config
ELEVENLABS_SIP_PHONE_ID=phnum_...          # after Plivo SIP import
PLIVO_AUTH_ID=...
PLIVO_AUTH_TOKEN=...
MAX_CONCURRENT=2
```

`DATABASE_URL` is overridden by compose to reach the `postgres` container — leave
the local-dev value as-is (it's ignored in the container).

## 4. Bring it up

```bash
docker compose up -d --build
docker compose ps          # all healthy?
docker compose logs -f app # "migrations applied" then "Server listening"
```

Migrations run automatically on container start.

## 5. Verify

```bash
curl https://$PUBLIC_DOMAIN/health          # {"status":"ok"} over TLS
# create an owner (real auth):
curl -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Test","phone":"+919999999999","vehicleTypes":["16ft"],"lanes":[]}' \
  https://$PUBLIC_DOMAIN/owners
```

## 6. Point ElevenLabs at it

In the EL agent's tools (see `docs/elevenlabs-agent-setup.md`), set the webhook
base to `https://$PUBLIC_DOMAIN`:
- `POST https://$PUBLIC_DOMAIN/webhooks/report-availability`
- `POST https://$PUBLIC_DOMAIN/webhooks/elevenlabs/post-call`
both with header `x-webhook-secret: $WEBHOOK_SECRET`.

## Updating later

```bash
git pull && docker compose up -d --build
```

## Backups

`pgdata` is a Docker volume on the instance. For real durability either snapshot
the OVH volume on a schedule, or `docker compose exec postgres pg_dump -U $PG_USER
$PG_DB > backup.sql` via cron and copy off-box (OVH Object Storage).
