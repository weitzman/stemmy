#!/usr/bin/env python3
"""Static server for local development that tells the browser not to cache.

python3 -m http.server sends no Cache-Control header, so Chrome caches app.js
and styles.css heuristically and a plain reload can run stale code. This
serves the repo root the same way, with caching off.

    python3 scripts/serve.py [port]
"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_head(self):
        # A copy cached before no-store took effect would be revalidated
        # and answered 304, keeping stale code alive; always send the file.
        del self.headers['If-Modified-Since']
        del self.headers['If-None-Match']
        return super().send_head()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
    print(f'Serving on http://localhost:{port}/ (no-store)')
    ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
