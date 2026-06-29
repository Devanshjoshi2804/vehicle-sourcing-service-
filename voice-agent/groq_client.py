"""Groq cloud calls: Whisper STT (Hindi) + chat LLM. Fast + free-tier, so the
turn latency stays low even on a small CPU box. (The call MEDIA stays in India;
these are side data calls for processing.)"""
import httpx

from config import CFG

BASE = "https://api.groq.com/openai/v1"


async def transcribe(wav_bytes: bytes) -> str:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{BASE}/audio/transcriptions",
            headers={"Authorization": f"Bearer {CFG.groq_api_key}"},
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            data={"model": CFG.stt_model, "language": "hi", "response_format": "json"},
        )
        r.raise_for_status()
        return (r.json().get("text") or "").strip()


async def chat(messages: list, tools: list | None = None) -> dict:
    body: dict = {"model": CFG.llm_model, "messages": messages, "temperature": 0.4}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(
            f"{BASE}/chat/completions",
            headers={"Authorization": f"Bearer {CFG.groq_api_key}"},
            json=body,
        )
        r.raise_for_status()
        return r.json()
