"""Persistent Parakeet worker. JSON lines in/out; model/download logs go to stderr."""
import contextlib
import json
import os
import sys
import time
import wave

MODEL = "mlx-community/parakeet-tdt-0.6b-v3"

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

def main():
    emit({"type": "status", "message": "Loading Parakeet locally…"})
    with contextlib.redirect_stdout(sys.stderr):
        import mlx.core as mx
        import numpy as np
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel
        model = from_pretrained(MODEL)
    emit({"type": "ready", "model": MODEL})
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            started = time.monotonic()
            with wave.open(request["path"], "rb") as wav:
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000:
                    raise ValueError("Expected mono 16-bit PCM WAV at 16000 Hz")
                samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
            with contextlib.redirect_stdout(sys.stderr):
                mel = get_logmel(mx.array(samples), model.preprocessor_config)
                result = model.generate(mel)[0]
            emit({"type": "transcript", "id": request["id"], "source": request.get("source", "Computer"), "text": result.text.strip(), "seconds": round(time.monotonic() - started, 3)})
            mx.clear_cache()
        except Exception as error:
            emit({"type": "error", "id": request.get("id"), "message": str(error)})

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "fatal", "message": str(error)})
        sys.exit(1)
