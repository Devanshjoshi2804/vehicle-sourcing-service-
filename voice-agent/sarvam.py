"""Sarvam AI — Indian telephony-tuned STT (saarika) + TTS (bulbul). Far better on
8 kHz Hindi phone audio than Whisper+gTTS. Used as the preferred provider when a
key is set; everything falls back to the free stack otherwise."""
import base64

import httpx

from config import CFG

STT_URL = "https://api.sarvam.ai/speech-to-text"
TTS_URL = "https://api.sarvam.ai/text-to-speech"

enabled = bool(CFG.sarvam_keys)


async def stt(wav_bytes: bytes) -> str | None:
    for key in CFG.sarvam_keys:
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(
                    STT_URL,
                    headers={"api-subscription-key": key},
                    files={"file": ("audio.wav", wav_bytes, "audio/wav")},
                    data={"model": CFG.sarvam_stt_model, "language_code": "hi-IN"},
                )
                if r.status_code == 429:
                    continue
                r.raise_for_status()
                return (r.json().get("transcript") or "").strip()
        except Exception:
            continue
    return None


async def tts_wav(text: str) -> bytes | None:
    """Returns WAV bytes (8 kHz) or None."""
    for key in CFG.sarvam_keys:
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.post(
                    TTS_URL,
                    headers={"api-subscription-key": key, "Content-Type": "application/json"},
                    json={
                        "text": text,
                        "target_language_code": "hi-IN",
                        "speaker": CFG.sarvam_speaker,
                        "model": CFG.sarvam_tts_model,
                        "speech_sample_rate": 8000,
                    },
                )
                if r.status_code == 429:
                    continue
                r.raise_for_status()
                audios = r.json().get("audios") or []
                if audios:
                    return base64.b64decode(audios[0])
        except Exception:
            continue
    return None
