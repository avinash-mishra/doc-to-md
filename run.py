#!/usr/bin/env python
"""Start the bench: python run.py  ->  http://127.0.0.1:8000"""

import argparse
import sys
import webbrowser

import uvicorn

# Windows consoles still default to cp1252, which cannot encode "→".
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


def main() -> None:
    parser = argparse.ArgumentParser(description="PDF -> Markdown converter bench")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = parser.parse_args()

    url = f"http://{'127.0.0.1' if args.host == '0.0.0.0' else args.host}:{args.port}"
    print(f"\n  PDF → Markdown Bench running at {url}\n")
    if not args.no_browser and not args.reload:
        webbrowser.open(url)

    uvicorn.run("backend.main:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
