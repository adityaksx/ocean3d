#!/usr/bin/env python3
"""SOLVX development launcher: prepare geometry, run FastAPI and Vite."""
from pathlib import Path
import json
import subprocess
import threading

ROOT = Path(__file__).resolve().parent


def start_api():
    import uvicorn
    from backend.main import app
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")


def main():
    from data import prepare

    public = ROOT / "public"
    public.mkdir(exist_ok=True)
    print("Preparing GEBCO/coast/EEZ geometry…")
    geometry = prepare(ROOT / "data")
    (public / "geometry.json").write_text(
        json.dumps(geometry, separators=(",", ":")), encoding="utf-8"
    )

    threading.Thread(target=start_api, daemon=True).start()
    print("Frontend: http://127.0.0.1:5500")
    print("API:      http://127.0.0.1:8000/docs")

    subprocess.run(["npm", "run", "dev"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
