"""Per-call conversation loop. Half-duplex turn-taking:
listen (VAD) → Groq Whisper (Hindi) → Groq LLM (intake + tool) → edge-tts → play.
On completion the agent calls our backend /webhooks/report-demand.
"""
import asyncio
import base64
import json

import httpx
import webrtcvad

import llm as groq
from audio import tts_to_ulaw, ulaw_to_pcm16
from config import CFG

FRAME_MS = 20
FRAME_BYTES = int(8000 * 2 * FRAME_MS / 1000)  # 320 bytes pcm16 / 20ms
# Wait ~1s of silence before treating the caller's turn as finished — long enough
# that someone reeling off "Mumbai se Delhi, 16 feet, 12000" in one breath isn't
# cut off mid-sentence (the old 800ms felt like the agent talked over you).
SILENCE_MS = 1000
MIN_SPEECH_BYTES = int(8000 * 2 * 0.6)  # ignore < 0.6s blips (noise/echo)

SYSTEM_PROMPT = (
    "You are Priya, a warm, polite female voice agent for {company}, an Indian vehicle/truck "
    "booking service. The CUSTOMER has called to book a vehicle. Speak ONLY in simple, natural "
    "Hindi/Hinglish, in SHORT replies (one short sentence, sometimes two), like a real phone call.\n"
    "\n"
    "Collect FIVE things: 1) vehicle type (e.g. 16 feet / 20 feet / 32 feet), 2) pickup location "
    "(area + city), 3) drop location (area + city), 4) price the customer can pay (rupees), "
    "5) date needed.\n"
    "\n"
    "HOW TO TALK — this matters most:\n"
    "- The caller often gives SEVERAL details in one breath, e.g. 'Mumbai se Delhi, 16 feet, "
    "12000 rupaye'. Capture EVERY detail in that turn. Remember what you already have and NEVER "
    "ask again for something already given.\n"
    "- Briefly repeat back what you understood so they know you heard, e.g. 'Theek hai — Mumbai se "
    "Delhi, 16 feet, 12 hazaar, note kiya.'\n"
    "- Then ask, in ONE short natural sentence, ONLY for what is still MISSING. Do not read a fixed "
    "list or ask things in a rigid order — just ask for what's left.\n"
    "- WAIT for the caller to finish; never talk over them, never rush, never repeat the greeting.\n"
    "- If something is unclear or sounds like noise, politely ask them to repeat just that one "
    "detail. NEVER guess or invent a value.\n"
    "- Once you have BOTH pickup and drop, confirm them once: 'Mumbai se Delhi, sahi hai?'.\n"
    "- Do NOT negotiate the price.\n"
    "\n"
    "When you have ALL FIVE and the locations are confirmed, CALL report_demand, then say exactly: "
    "'Theek hai, aapki request note kar li hai, hum 2 minute mein call back karenge. Dhanyavaad.' "
    "and stop."
)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "report_demand",
            "description": "Submit the customer's vehicle request once all details are collected.",
            "parameters": {
                "type": "object",
                "properties": {
                    "fromText": {"type": "string", "description": "Pickup location as said (area + city)."},
                    "toText": {"type": "string", "description": "Drop location as said (area + city)."},
                    "vehicleType": {"type": "string", "description": "Vehicle type e.g. 16ft."},
                    "offeredPriceInr": {"type": "integer", "description": "Price in rupees the customer can pay."},
                    "pickupDate": {"type": "string", "description": "Date needed (any format)."},
                    "note": {"type": "string", "description": "Any extra detail."},
                },
                "required": ["fromText", "toText", "vehicleType", "offeredPriceInr", "pickupDate"],
            },
        },
    }
]


class Call:
    def __init__(self, ws, from_number: str):
        self.ws = ws
        self.from_number = from_number or "unknown"
        self.stream_id = ""
        self.vad = webrtcvad.Vad(3)  # most aggressive — filter telephony noise
        self.pcm_buf = b""
        self.utterance = bytearray()
        self.triggered = False
        self.silence_frames = 0
        self.speaking = False
        self.done = False
        self.messages = [{"role": "system", "content": SYSTEM_PROMPT.format(company=CFG.company)}]

    # ---- audio out ----
    async def play(self, ulaw: bytes):
        if not ulaw:
            return
        await self.ws.send_json(
            {
                "event": "playAudio",
                "media": {
                    "contentType": "audio/x-mulaw",
                    "sampleRate": 8000,
                    "payload": base64.b64encode(ulaw).decode(),
                },
            }
        )

    async def say(self, text: str):
        if not text:
            return
        self.speaking = True
        try:
            ulaw = await tts_to_ulaw(text, CFG.tts_voice)
            await self.play(ulaw)
            await asyncio.sleep(len(ulaw) / 8000.0 + 0.4)  # let it finish before listening
        finally:
            # drop anything captured while we were talking (avoid self-echo)
            self.pcm_buf = b""
            self.utterance = bytearray()
            self.triggered = False
            self.silence_frames = 0
            self.speaking = False

    async def greet(self):
        await self.say(
            f"Namaste, {CFG.company} se baat ho rahi hai. Bataiye, kaisi gaadi chahiye aur kahan se kahan jaani hai?"
        )

    # ---- audio in ----
    async def on_media(self, payload_b64: str):
        if self.speaking or self.done:
            return
        self.pcm_buf += ulaw_to_pcm16(base64.b64decode(payload_b64))
        while len(self.pcm_buf) >= FRAME_BYTES:
            frame = self.pcm_buf[:FRAME_BYTES]
            self.pcm_buf = self.pcm_buf[FRAME_BYTES:]
            speech = self.vad.is_speech(frame, 8000)
            if speech:
                self.triggered = True
                self.silence_frames = 0
                self.utterance += frame
            elif self.triggered:
                self.silence_frames += 1
                self.utterance += frame
                if self.silence_frames * FRAME_MS >= SILENCE_MS:
                    utt = bytes(self.utterance)
                    self.utterance = bytearray()
                    self.triggered = False
                    self.silence_frames = 0
                    if len(utt) >= MIN_SPEECH_BYTES:
                        await self.handle_utterance(utt)

    async def handle_utterance(self, pcm: bytes):
        try:
            text = await groq.transcribe(pcm)
        except Exception as e:
            print(f"[stt] error: {e}", flush=True)
            return
        # drop empty / single-char noise transcriptions
        if len(text.strip()) < 2:
            print(f"[stt] dropped noise: {text!r}", flush=True)
            return
        print(f"[stt] caller: {text}", flush=True)
        self.messages.append({"role": "user", "content": text})
        await self.respond()

    async def respond(self):
        resp = await groq.chat(self.messages, TOOLS)
        msg = resp["choices"][0]["message"]
        self.messages.append(msg)
        tool_calls = msg.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                if tc["function"]["name"] == "report_demand":
                    try:
                        args = json.loads(tc["function"]["arguments"] or "{}")
                    except Exception:
                        args = {}
                    result = await self.report_demand(args)
                    print(f"[demand] {args} -> {result}", flush=True)
                    self.messages.append(
                        {"role": "tool", "tool_call_id": tc.get("id", ""), "content": json.dumps(result)}
                    )
            resp2 = await groq.chat(self.messages, TOOLS)
            final = resp2["choices"][0]["message"]
            await self.say(
                final.get("content")
                or "Theek hai, aapki request note kar li hai, hum 2 minute mein call back karenge. Dhanyavaad."
            )
            self.done = True
            await asyncio.sleep(0.3)
            try:
                await self.ws.close()
            except Exception:
                pass
        else:
            print(f"[llm] agent: {(msg.get('content') or '')[:90]}", flush=True)
            await self.say(msg.get("content") or "Maaf kijiye, dobara boliye.")

    async def report_demand(self, args: dict) -> dict:
        body = {
            "conversationId": self.stream_id or f"voice_{self.from_number}",
            "customerPhone": self.from_number,
            "fromText": args.get("fromText") or "unknown",
            "toText": args.get("toText") or "unknown",
            "vehicleType": args.get("vehicleType"),
            "offeredPriceInr": args.get("offeredPriceInr"),
            "pickupDate": args.get("pickupDate"),
            "note": args.get("note"),
        }
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.post(
                    f"{CFG.backend_base}/webhooks/report-demand",
                    headers={"x-webhook-secret": CFG.webhook_secret},
                    json=body,
                )
                return {"ok": r.status_code in (200, 201), "status": r.status_code}
        except Exception as e:
            return {"ok": False, "error": str(e)}
