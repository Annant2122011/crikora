import { createServer } from "node:http";
import handler from "../api/[...path].js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 8787);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError("PORT must be an integer between 1 and 65535.");
}

const server = createServer((request, response) => {
  void handler(request, response).catch(error => {
    console.error("Crikora Railway API request failed", error);
    if (!response.headersSent) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ error: "Internal server error." }));
    } else {
      response.end();
    }
  });
});

server.requestTimeout = 75_000;
server.headersTimeout = 80_000;
server.keepAliveTimeout = 5_000;

server.listen(port, host, () => {
  console.info(`Crikora Railway API listening on http://${host}:${port}`);
});

const shutdown = (signal: string) => {
  console.info(`Received ${signal}; closing the Crikora API listener.`);
  server.close(error => {
    if (error) {
      console.error("Crikora API shutdown failed", error);
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
