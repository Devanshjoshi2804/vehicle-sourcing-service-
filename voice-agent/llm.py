"""Resilient LLM + STT. Every call walks a provider→key chain; a 429 (rate limit)
or 5xx/transport error rolls to the next key, then the next provider. So a live
call never dies because one key got exhausted.

All three chat providers expose an OpenAI-compatible endpoint (same request +
tool-calling shape), so one code path covers Groq, Mistral and Gemini.
"""
import httpx

from config import CFG

# (label, base_url, [keys], model)
CHAT_CHAIN = [
    ("groq", "https://api.groq.com/openai/v1", CFG.groq_keys, CFG.groq_model),
    ("mistral", "https://api.mistral.ai/v1", CFG.mistral_keys, CFG.mistral_model),
    ("gemini", "https://generativelanguage.googleapis.com/v1beta/openai", CFG.gemini_keys, CFG.gemini_model),
]

STT_CHAIN = [
    ("groq", "https://api.groq.com/openai/v1", CFG.groq_keys, CFG.stt_model),
    ("mistral", "https://api.mistral.ai/v1", CFG.mistral_keys, "voxtral-mini-latest"),
]


def _retryable(status: int) -> bool:
    return status == 429 or status >= 500


async def chat(messages: list, tools: list | None = None) -> dict:
    body: dict = {"messages": messages, "temperature": 0.4}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    last = None
    async with httpx.AsyncClient(timeout=30) as c:
        for label, base, keys, model in CHAT_CHAIN:
            for key in keys:
                try:
                    r = await c.post(
                        f"{base}/chat/completions",
                        headers={"Authorization": f"Bearer {key}"},
                        json={**body, "model": model},
                    )
                    if _retryable(r.status_code):
                        last = f"{label} {r.status_code}"
                        continue
                    r.raise_for_status()
                    return r.json()
                except Exception as e:  # noqa: BLE001
                    last = f"{label}: {e}"
                    continue
    raise RuntimeError(f"all chat providers failed (last: {last})")


async def transcribe(wav_bytes: bytes) -> str:
    last = None
    async with httpx.AsyncClient(timeout=30) as c:
        for label, base, keys, model in STT_CHAIN:
            for key in keys:
                try:
                    r = await c.post(
                        f"{base}/audio/transcriptions",
                        headers={"Authorization": f"Bearer {key}"},
                        files={"file": ("audio.wav", wav_bytes, "audio/wav")},
                        data={"model": model, "language": "hi", "response_format": "json"},
                    )
                    if _retryable(r.status_code):
                        last = f"{label} {r.status_code}"
                        continue
                    r.raise_for_status()
                    return (r.json().get("text") or "").strip()
                except Exception as e:  # noqa: BLE001
                    last = f"{label}: {e}"
                    continue
    return ""  # best-effort: a failed turn just re-prompts
