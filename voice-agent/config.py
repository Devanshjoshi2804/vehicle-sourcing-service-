import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    llm_model: str = os.getenv("LLM_MODEL", "llama-3.3-70b-versatile")
    stt_model: str = os.getenv("STT_MODEL", "whisper-large-v3")
    tts_voice: str = os.getenv("TTS_VOICE", "hi-IN-SwaraNeural")
    company: str = os.getenv("COMPANY_NAME", "Pinified")
    backend_base: str = os.getenv("BACKEND_BASE", "http://app:4200")
    webhook_secret: str = os.getenv("WEBHOOK_SECRET", "")
    # public wss host Plivo connects to (Caddy terminates TLS → this service)
    public_wss_host: str = os.getenv("PUBLIC_WSS_HOST", "")
    port: int = int(os.getenv("PORT", "4300"))


CFG = Config()
