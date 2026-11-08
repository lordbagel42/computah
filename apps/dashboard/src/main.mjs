import { startObservability, traceHttp } from "@computah/observability";
import { createDashboardServer, readDashboardConfig } from "./server.mjs";

const telemetry = await startObservability("dashboard");
const config = readDashboardConfig(process.env);
const server = createDashboardServer(config);
traceHttp(server);
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
server.listen(config.port, config.host, () => {
  console.info("Computah dashboard listening; operator login required");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      void telemetry.close();
    });
    server.closeAllConnections();
  });
}
