"""Per-call conversation loop. Half-duplex turn-taking:
listen (VAD) → Groq Whisper (Hindi) → Groq LLM (intake + tool) → edge-tts → play.
On completion the agent calls our backend /webhooks/report-demand.
"""
import asyncio
import base64
import json

import httpx
import webrtcvad

import groq_client as groq
from audio import pcm16_to_wav, tts_to_ulaw, ulaw_to_pcm16
from config import CFG

FRAME_MS = 20
FRAME_BYTES = int(8000 * 2 * FRAME_MS / 1000)  # 320 bytes pcm16 / 20ms
SILENCE_MS = 800
MIN_SPEECH_BYTES = int(8000 * 2 * 0.4)  # ignore < 0.4s blips

SYSTEM_PROMPT = (
    "You are a warm, polite female voice agent for {company}, an Indian vehicle/truck "
    "booking service. The CUSTOMER has called to request a vehicle. Speak ONLY in simple, "
    "natural Hindi (Hinglish is fine), in SHORT one-sentence replies suitable for a phone call.\n"
    "Collect, ONE question per turn: 1) kaisi gaadi chahiye (vehicle type e.g. 16ft/20ft/32ft), "
    "2) pickup kahan se (area + city), 3) drop kahan (area + city), 4) kitna price de sakte hain "
    "(rupees), 5) kab chahiye (date). Briefly read the pickup and drop back to confirm. Do NOT "
    "negotiate price. When you have ALL details, CALL the tool report_demand. After it runs, say "
    "exactly: 'Theek hai, aapki request note kar li hai, hum 2 minute mein call back karenge. "
    "Dhanyavaad.' and stop. Never invent details; keep every reply short."
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
                "required": ["fromText", "toText"],
            },
        },
    }
]


class Call:
    def __init__(self, ws, from_number: str):
        self.ws = ws
        self.from_number = from_number or "unknown"
        self.stream_id = ""
        self.vad = webrtcvad.Vad(2)
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
            text = await groq.transcribe(pcm16_to_wav(pcm))
        except Exception:
            return
        if not text:
            return
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
