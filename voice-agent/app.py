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


def _stream_xml(params: dict) -> str:
    host = CFG.public_wss_host
    q = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
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


# Inbound: a customer calls our number → demand-intake conversation.
@app.api_route("/answer", methods=["GET", "POST"])
async def answer(request: Request):
    from_number = await _from(request)
    return Response(content=_stream_xml({"from": from_number, "mode": "intake"}), media_type="application/xml")


# Outbound: our backend originated a call to a vehicle owner → driver-offer
# conversation. The load context rides in on the answer URL query params and is
# forwarded into the media stream.
@app.api_route("/answer-outbound", methods=["GET", "POST"])
async def answer_outbound(request: Request):
    qp = request.query_params
    params = {
        "mode": "offer",
        "cid": qp.get("cid") or "",
        "owner": qp.get("owner") or "",
        "frm": qp.get("frm") or "",
        "to": qp.get("to") or "",
        "vt": qp.get("vt") or "",
        "price": qp.get("price") or "",
        "flow": qp.get("flow") or "offer",
    }
    return Response(content=_stream_xml(params), media_type="application/xml")


@app.websocket("/stream")
async def stream(ws: WebSocket):
    await ws.accept()
    qp = ws.query_params
    from_number = qp.get("from") or ""
    mode = qp.get("mode") or "intake"
    ctx = None
    if mode == "offer":
        ctx = {k: qp.get(k) for k in ("cid", "owner", "frm", "to", "vt", "price", "flow")}
        print(f"[stream] connected, OUTBOUND offer cid={ctx.get('cid')} {ctx.get('frm')}->{ctx.get('to')}", flush=True)
    else:
        print(f"[stream] connected, caller={from_number or 'unknown'}", flush=True)
    call = Call(ws, from_number, mode=mode, ctx=ctx)
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
