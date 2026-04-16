#!/usr/bin/env python3
import argparse
import threading
from pathlib import Path
from http.server import ThreadingHTTPServer

from ai_office_app import (
    AIOfficeState,
    DEFAULT_HOST,
    DEFAULT_LOG_FILE,
    DEFAULT_PORT,
    DEFAULT_TIMEOUT_SEC,
    Handler,
    load_local_env,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AI Office desktop app")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SEC)
    parser.add_argument("--log-file", default=DEFAULT_LOG_FILE)
    parser.add_argument("--title", default="AI Office")
    return parser.parse_args()


def main() -> int:
    load_local_env()
    args = parse_args()

    log_path = Path(args.log_file).resolve()
    state = AIOfficeState(log_path=log_path, timeout_sec=args.timeout)
    Handler.state = state

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        import webview  # pywebview
    except Exception as exc:
        print("Desktop UI dependency missing (pywebview).")
        print(f"Open manually in browser: {url}")
        print(f"Details: {exc}")
        try:
            thread.join()
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            server.server_close()
        return 1

    try:
        webview.create_window(args.title, url, width=1500, height=900, min_size=(1100, 700))
        webview.start()
    finally:
        server.shutdown()
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
