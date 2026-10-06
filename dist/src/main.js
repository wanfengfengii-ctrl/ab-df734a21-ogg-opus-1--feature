import { createAuditServer } from "./server.js";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid PORT: ${process.env.PORT ?? ""}`);
    process.exit(1);
}
const host = process.env.HOST ?? "0.0.0.0";
const server = createAuditServer();
server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`opus-archive-audit listening on http://${host}:${port}`);
});
const shutdown = (signal) => {
    server.close(() => {
        process.exit(0);
    });
    void signal;
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
