// Node's `ws` client sends no Origin header, so the runtime's socket-upgrade gate
// (see handleSocketUpgrade in src/server/middleware.ts) answers 403 via rejectSocket.
// Tests opt in by deriving the http(s) origin for a ws(s) URL and passing it as an
// explicit `origin` header on every test WebSocket.
export function wsHttpOrigin(url: string): string {
	return new URL(url.replace(/^wss:/, "https:").replace(/^ws:/, "http:")).origin;
}
