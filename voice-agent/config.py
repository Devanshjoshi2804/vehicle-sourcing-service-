import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv()


def _keys(primary_env: str, fallback_env: str) -> list[str]:
    keys = []
    p = os.getenv(primary_env, "").strip()
    if p:
        keys.append(p)
    for k in os.getenv(fallback_env, "").split(","):
        k = k.strip()
        if k:
            keys.append(k)
    return keys


@dataclass
class Config:
    # chat/LLM + STT providers (tried in order; keys rotate on 429)
    groq_keys: list[str] = field(default_factory=lambda: _keys("GROQ_API_KEY", "GROQ_FALLBACK_KEYS"))
    groq_model: str = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
    mistral_keys: list[str] = field(default_factory=lambda: _keys("MISTRAL_API_KEY", "MISTRAL_FALLBACK_KEYS"))
    mistral_model: str = os.getenv("MISTRAL_MODEL", "mistral-large-latest")
    gemini_keys: list[str] = field(default_factory=lambda: _keys("GEMINI_API_KEY", "GEMINI_FALLBACK_KEYS"))
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
    stt_model: str = os.getenv("STT_MODEL", "whisper-large-v3")

    tts_voice: str = os.getenv("TTS_VOICE", "hi-IN-SwaraNeural")
    company: str = os.getenv("COMPANY_NAME", "Pinified")
    backend_base: str = os.getenv("BACKEND_BASE", "http://app:4200")
    webhook_secret: str = os.getenv("WEBHOOK_SECRET", "")
    public_wss_host: str = os.getenv("PUBLIC_WSS_HOST", "")
    port: int = int(os.getenv("PORT", "4300"))


CFG = Config()
