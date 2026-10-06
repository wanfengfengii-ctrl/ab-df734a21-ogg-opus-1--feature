import { createServer } from "node:http";
import { auditOggOpus, AuditError, MAX_BODY_BYTES, MAX_PAGES } from "./audit.js";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
function sendJson(res, status, body) {
    if (res.writableEnded || res.destroyed) {
        return false;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, JSON_HEADERS);
    res.end(payload);
    return true;
}
function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on("data", (chunk) => {
            if (settled) {
                return;
            }
            size += chunk.length;
            if (size > maxBytes) {
                // Stop retaining bytes and keep draining the request so the
                // 413 response can still be written cleanly.
                settled = true;
                chunks.length = 0;
                reject(new BodyTooLargeError());
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (!settled) {
                resolve(Buffer.concat(chunks));
            }
        });
        req.on("error", (err) => {
            if (!settled) {
                reject(err);
            }
        });
    });
}
class BodyTooLargeError extends Error {
    constructor() {
        super("request body exceeds 8 MiB");
        this.name = "BodyTooLargeError";
    }
}
export function createAuditServer(options = {}) {
    const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
    return createServer((req, res) => {
        const method = req.method ?? "";
        const url = req.url ?? "/";
        const path = url.split("?")[0] ?? "/";
        if (method === "GET" && path === "/health") {
            sendJson(res, 200, { status: "ok" });
            return;
        }
        if (method !== "POST" || path !== "/api/opus/audit") {
            sendJson(res, 404, { error: { code: "NOT_FOUND", message: "unknown route" } });
            return;
        }
        const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
        if (contentType !== "audio/ogg") {
            sendJson(res, 415, {
                error: {
                    code: "UNSUPPORTED_MEDIA_TYPE",
                    message: "Content-Type must be audio/ogg",
                },
            });
            return;
        }
        readBody(req, maxBytes)
            .then((body) => {
            try {
                const result = auditOggOpus(body);
                sendJson(res, 200, result);
            }
            catch (err) {
                if (err instanceof AuditError) {
                    sendJson(res, err.status, {
                        error: {
                            code: err.code,
                            message: err.message,
                            page: err.pageIndex,
                        },
                    });
                    return;
                }
                throw err;
            }
        })
            .catch((err) => {
            if (err instanceof BodyTooLargeError) {
                sendJson(res, 413, {
                    error: { code: "PAYLOAD_TOO_LARGE", message: `body must not exceed ${maxBytes} bytes` },
                });
                return;
            }
            sendJson(res, 400, {
                error: { code: "BAD_REQUEST", message: err instanceof Error ? err.message : "read error" },
            });
        });
    });
}
// The page guard lives inside the auditor; the limit is exported for
// callers that advertise constraints.
export { MAX_BODY_BYTES, MAX_PAGES };
