"""India-hosted voice agent. Plivo terminates the call in India and streams the
caller's audio here (media stays in India → no domestic-anchoring error). We run
the Hindi conversation and submit the demand to the backend.
"""
import urllib.parse

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from config import CFG
from pipeline import Call

app = FastAPI()


@app.get("/health")
async def health():
    return {"status": "ok"}


def _stream_xml(from_number: str) -> str:
    host = CFG.public_wss_host
    q = urllib.parse.urlencode({"from": from_number})
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Response>\n"
        f'  <Stream bidirectional="true" keepCallAlive="true" '
        f'contentType="audio/x-mulaw;rate=8000">wss://{host}/stream?{q}</Stream>\n'
        "</Response>"
    )


async def _from(request: Request) -> str:
    if request.method == "POST":
        try:
            form = await request.form()
            if form.get("From"):
                return str(form.get("From"))
        except Exception:
            pass
    return request.query_params.get("From") or request.query_params.get("from") or ""


@app.api_route("/answer", methods=["GET", "POST"])
async def answer(request: Request):
    from_number = await _from(request)
    return Response(content=_stream_xml(from_number), media_type="application/xml")


@app.websocket("/stream")
async def stream(ws: WebSocket):
    await ws.accept()
    from_number = ws.query_params.get("from") or ""
    call = Call(ws, from_number)
    greeted = False
    try:
        while True:
            msg = await ws.receive_json()
            event = msg.get("event")
            if event == "start":
                call.stream_id = msg.get("streamId") or (msg.get("start") or {}).get("streamId") or ""
                if not greeted:
                    greeted = True
                    await call.greet()
            elif event == "media":
                if not greeted:
                    # some streams send media before we see 'start'
                    greeted = True
                    await call.greet()
                payload = (msg.get("media") or {}).get("payload")
                if payload:
                    await call.on_media(payload)
            elif event == "stop":
                break
    except WebSocketDisconnect:
        pass
    except Exception:
        pass


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=CFG.port)
