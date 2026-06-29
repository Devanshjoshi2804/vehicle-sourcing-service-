# ElevenLabs + Plivo SIP — one-time setup

The service originates calls through **ElevenLabs ConvAI**, which dials over a
**Plivo SIP trunk**. This is dashboard setup done once; the values land in `.env`.

Verified endpoint (ElevenLabs): `POST https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call`
(header `xi-api-key`; body `agent_id`, `agent_phone_number_id`, `to_number`,
`conversation_initiation_client_data.dynamic_variables`; response has `conversation_id`).
Official refs: ElevenLabs SIP outbound-call API; Plivo "SIP Trunking with ElevenLabs" quickstart.

## 1. Plivo SIP trunk (Zentrunk)
1. Plivo dashboard → Zentrunk → create an **outbound** trunk.
2. Note the trunk's SIP termination host/URI and credentials.
3. Keep Outbound CPS in mind — the trial shows **CPS = 2**; set `MAX_CONCURRENT` to match.

## 2. Import the trunk into ElevenLabs
1. ElevenLabs → Conversational AI → **Phone Numbers** → add a SIP trunk phone number.
2. Enter the Plivo trunk host/credentials from step 1.
3. Copy the resulting phone-number id → `ELEVENLABS_SIP_PHONE_ID` (`phnum_…`).

## 3. Create the ConvAI agent (Hindi)
Create one agent; branch its system prompt on `{{flow}}`:

- **`offer`**: greet `{{owner_name}}`, ask if a `{{vehicle_type}}` vehicle is available
  `{{from}}` → `{{to}}` on `{{pickup_date}}`. If yes, state the rate is `₹{{fixed_price}}`
  **fixed** and ask if they accept (yes/no).
- **`fixed_price_followup`**: state `₹{{fixed_price}}` is the **final, non-negotiable**
  price — accept or the booking can't be confirmed. Record accept/decline.
- Always include: `FACTS: only use the dynamic variables above — never invent trip or price details.`

Copy the agent id → `ELEVENLABS_AGENT_SOURCING` (`agent_…`).

## 4. Register tools on the agent
Add these as agent tools (workspace → tools), pointing at this service:

### `report_availability`
- `POST {PUBLIC_BASE_URL}/webhooks/report-availability`
- Header: `x-webhook-secret: {WEBHOOK_SECRET}`
- Body: `{ conversationId, available, quotedPriceInr?, acceptsFixed?, vehicleType?, note? }`
  - `available`: `YES` | `NO` | `CALLBACK`
  - `acceptsFixed`: `true` when the owner takes `₹{{fixed_price}}`, `false` when they want more
- Map `conversationId` to the EL conversation id (confirm the exact variable name in the
  tool config — it must be the same id returned by the originate call).

### post-call webhook
- `POST {PUBLIC_BASE_URL}/webhooks/elevenlabs/post-call`
- Header: `x-webhook-secret: {WEBHOOK_SECRET}`
- Body: `{ conversationId, transcript }`

## 5. Sanity
- `PUBLIC_BASE_URL` must be reachable by ElevenLabs (public host / tunnel in dev).
- A `report_availability` with `available=YES, acceptsFixed=false` on an `offer` call
  auto-triggers a `fixed_price_followup` call to the same owner.
