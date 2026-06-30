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
# Wait ~1.6s of silence before treating the caller's turn as finished. People
# pause mid-sentence to think; at 1s the agent jumped in over them. 1.6s lets the
# caller breathe/continue before the agent responds (small latency cost, worth it).
SILENCE_MS = 1600
MIN_SPEECH_BYTES = int(8000 * 2 * 0.6)  # ignore < 0.6s blips (noise/echo)

SYSTEM_PROMPT = (
    "You are Priya, a warm, polite female voice agent for {company}, an Indian vehicle/truck "
    "booking service. The CUSTOMER has called to book a vehicle.\n"
    "Reply in simple, natural Hindi, WRITTEN IN DEVANAGARI SCRIPT (देवनागरी) — NOT in Roman/English "
    "letters — because the text is read aloud by a Hindi voice and Roman text sounds garbled. "
    "Keep place names and numbers as the caller said them. SHORT replies (one short sentence, "
    "sometimes two), like a real phone call.\n"
    "\n"
    "Collect FIVE things: 1) vehicle type (e.g. 16 feet / 20 feet / 32 feet), 2) pickup location "
    "(area + city), 3) drop location (area + city), 4) price the customer can pay (rupees), "
    "5) date needed.\n"
    "\n"
    "HOW TO TALK — this matters most:\n"
    "- The caller often gives SEVERAL details in one breath, e.g. 'Mumbai se Delhi, 16 feet, "
    "12000 rupaye'. Capture EVERY detail in that turn. Remember what you already have and NEVER "
    "ask again for something already given.\n"
    "- Briefly repeat back what you understood so they know you heard, e.g. "
    "'ठीक है — मुंबई से दिल्ली, 16 फीट, 12 हज़ार, नोट कर लिया।'\n"
    "- Then ask, in ONE short natural sentence, ONLY for what is still MISSING. Do not read a fixed "
    "list or ask things in a rigid order — just ask for what's left.\n"
    "- WAIT for the caller to finish; never talk over them, never rush, never repeat the greeting.\n"
    "- Keep EVERY reply to ONE short sentence, max ~12 words. Ask one thing, then STOP and let them "
    "speak. Never give long explanations or apologise at length.\n"
    "- If something is unclear or sounds like noise, politely ask them to repeat just that one "
    "detail. NEVER guess or invent a value.\n"
    "- Once you have BOTH pickup and drop, confirm them once: 'मुंबई से दिल्ली, सही है?'.\n"
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

# ---- OUTBOUND: calling a vehicle owner to offer a load at a fixed price ----
OFFER_PROMPT = (
    "You are Priya, a warm, polite female voice agent for {company}. You are CALLING a vehicle "
    "owner named {owner_name} to offer them a load.\n"
    "Reply in simple, natural Hindi, WRITTEN IN DEVANAGARI SCRIPT (देवनागरी) — NOT in Roman/English "
    "letters — because the text is read aloud by a Hindi voice and Roman text sounds garbled. Keep "
    "place names and numbers as-is. One short sentence per turn, like a real phone call.\n"
    "\n"
    "The load: {frm} se {to}, {vehicle_type} gaadi, fixed rate {fixed_price} rupaye. "
    "This price is FINAL — you must NOT negotiate.\n"
    "\n"
    "Your only goal: find out whether {owner_name} will take THIS load at {fixed_price} rupaye, "
    "then call report_availability and end the call.\n"
    "\n"
    "RULES:\n"
    "- YOU speak first (you already greeted with the offer). Wait for their reply; never talk over them.\n"
    "- Do NOT negotiate. If they ask for more money, say politely it is a fixed-price load, note the "
    "number they asked, and close.\n"
    "- If unclear or noisy, ask once to repeat. NEVER guess.\n"
    "- Keep EVERY reply to ONE short sentence, max ~12 words. Then STOP and let them speak.\n"
    "\n"
    "Decide ONE outcome and pass it to report_availability:\n"
    "- Yes at the fixed price: available=YES, acceptsFixed=true.\n"
    "- Available but wants more money: available=YES, acceptsFixed=false, quotedPriceInr=<their number>.\n"
    "- Not available / not interested: available=NO.\n"
    "- Busy / call later: available=CALLBACK.\n"
    "After report_availability returns, say a short Devanagari Hindi closing (e.g. 'धन्यवाद!') and stop."
)

OFFER_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "report_availability",
            "description": "Report whether the owner takes the load at the fixed price. Call once, when decided.",
            "parameters": {
                "type": "object",
                "properties": {
                    "available": {"type": "string", "enum": ["YES", "NO", "CALLBACK"]},
                    "acceptsFixed": {"type": "boolean", "description": "True only if they take the FIXED price."},
                    "quotedPriceInr": {"type": "integer", "description": "Rupees they asked for, if they wanted more."},
                    "note": {"type": "string", "description": "Short summary of the outcome."},
                },
                "required": ["available"],
            },
        },
    }
]


class Call:
    def __init__(self, ws, from_number: str, mode: str = "intake", ctx: dict | None = None):
        self.ws = ws
        self.from_number = from_number or "unknown"
        self.mode = mode  # "intake" (inbound customer) | "offer" (outbound driver)
        self.ctx = ctx or {}
        self.stream_id = ""
        self.vad = webrtcvad.Vad(3)  # most aggressive — filter telephony noise
        self.pcm_buf = b""
        self.utterance = bytearray()
        self.triggered = False
        self.silence_frames = 0
        self.speaking = False
        self.done = False
        if mode == "offer":
            system = OFFER_PROMPT.format(
                company=CFG.company,
                owner_name=self.ctx.get("owner") or "ji",
                frm=self.ctx.get("frm") or "",
                to=self.ctx.get("to") or "",
                vehicle_type=self.ctx.get("vt") or "",
                fixed_price=self.ctx.get("price") or "",
            )
            self.tools = OFFER_TOOLS
        else:
            system = SYSTEM_PROMPT.format(company=CFG.company)
            self.tools = TOOLS
        self.messages = [{"role": "system", "content": system}]

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
        if self.mode == "offer":
            owner = self.ctx.get("owner") or "ji"
            frm = self.ctx.get("frm") or ""
            to = self.ctx.get("to") or ""
            vt = self.ctx.get("vt") or ""
            price = self.ctx.get("price") or ""
            if self.ctx.get("flow") == "fixed_price_followup":
                line = (
                    f"नमस्ते {owner} जी, {CFG.company} से फिर बात हो रही है। {frm} से {to} वाले "
                    f"लोड के लिए हम {price} रुपये फिक्स्ड ही दे सकते हैं — क्या आप इस फाइनल रेट पर हाँ करेंगे?"
                )
            else:
                line = (
                    f"नमस्ते {owner} जी, {CFG.company} से बात हो रही है। एक लोड है {frm} से {to}, "
                    f"{vt} गाड़ी, फिक्स्ड रेट {price} रुपये। क्या आप यह लोड इस रेट पर ले सकते हैं?"
                )
            await self.say(line)
        else:
            await self.say(
                f"नमस्ते, {CFG.company} से बात हो रही है। बताइए, कैसी गाड़ी चाहिए और कहाँ से कहाँ जानी है?"
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
        resp = await groq.chat(self.messages, self.tools)
        msg = resp["choices"][0]["message"]
        self.messages.append(msg)
        tool_calls = msg.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                name = tc["function"]["name"]
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                except Exception:
                    args = {}
                if name == "report_demand":
                    result = await self.report_demand(args)
                elif name == "report_availability":
                    result = await self.report_availability(args)
                else:
                    result = {"ok": False, "error": f"unknown tool {name}"}
                print(f"[{name}] {args} -> {result}", flush=True)
                self.messages.append(
                    {"role": "tool", "tool_call_id": tc.get("id", ""), "content": json.dumps(result)}
                )
            resp2 = await groq.chat(self.messages, self.tools)
            final = resp2["choices"][0]["message"]
            default_close = (
                "ठीक है, धन्यवाद!"
                if self.mode == "offer"
                else "ठीक है, आपकी रिक्वेस्ट नोट कर ली है, हम 2 मिनट में कॉल बैक करेंगे। धन्यवाद।"
            )
            await self.say(final.get("content") or default_close)
            self.done = True
            await asyncio.sleep(0.3)
            try:
                await self.ws.close()
            except Exception:
                pass
        else:
            print(f"[llm] agent: {(msg.get('content') or '')[:90]}", flush=True)
            await self.say(msg.get("content") or "माफ़ कीजिए, दोबारा बोलिए।")

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

    async def report_availability(self, args: dict) -> dict:
        # conversationId is the id the backend generated and passed in on the
        # answer URL — so this report matches the right call_attempt.
        body = {
            "conversationId": self.ctx.get("cid") or self.stream_id or f"voice_{self.from_number}",
            "available": (args.get("available") or "CALLBACK").upper(),
            "acceptsFixed": args.get("acceptsFixed"),
            "quotedPriceInr": args.get("quotedPriceInr"),
            "vehicleType": self.ctx.get("vt"),
            "note": args.get("note"),
        }
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.post(
                    f"{CFG.backend_base}/webhooks/report-availability",
                    headers={"x-webhook-secret": CFG.webhook_secret},
                    json=body,
                )
                return {"ok": r.status_code in (200, 201), "status": r.status_code}
        except Exception as e:
            return {"ok": False, "error": str(e)}
