FROM python:3.12-slim

# ffmpeg → pydub MP3 decode (edge-tts); build tools → webrtcvad C extension
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg gcc build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./

EXPOSE 4300
CMD ["python", "app.py"]
