"""Audio helpers — everything is telephony μ-law 8 kHz mono.

Plivo streams inbound caller audio as base64 μ-law/8000; we play audio back the
same way. STT wants a WAV; edge-tts gives MP3 — both get converted here.
"""
import asyncio
import audioop
import io
import wave

import edge_tts
from gtts import gTTS
from pydub import AudioSegment

SAMPLE_RATE = 8000


def ulaw_to_pcm16(ulaw: bytes) -> bytes:
    return audioop.ulaw2lin(ulaw, 2)


def pcm16_to_ulaw(pcm: bytes) -> bytes:
    return audioop.lin2ulaw(pcm, 2)


def pcm16_to_wav(pcm: bytes, rate: int = SAMPLE_RATE) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


async def _edge_mp3(text: str, voice: str) -> bytes:
    mp3 = bytearray()
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            mp3.extend(chunk["data"])
    return bytes(mp3)


def _gtts_mp3(text: str) -> bytes:
    buf = io.BytesIO()
    gTTS(text, lang="hi").write_to_fp(buf)
    return buf.getvalue()


async def tts_to_ulaw(text: str, voice: str) -> bytes:
    """Hindi speech → μ-law 8 kHz mono. edge-tts (best voice) with a gTTS
    fallback — datacenter IPs get 403'd by edge-tts, so we always have a backup.
    """
    mp3 = b""
    try:
        mp3 = await _edge_mp3(text, voice)
    except Exception:
        mp3 = b""
    if not mp3:
        try:
            mp3 = await asyncio.get_event_loop().run_in_executor(None, _gtts_mp3, text)
        except Exception:
            return b""
    if not mp3:
        return b""
    seg = AudioSegment.from_file(io.BytesIO(mp3), format="mp3")
    seg = seg.set_frame_rate(SAMPLE_RATE).set_channels(1).set_sample_width(2)
    return pcm16_to_ulaw(seg.raw_data)
