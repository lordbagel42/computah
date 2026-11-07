import * as Docker from "@alchemy.run/docker";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

const image = process.env.COMPUTAH_IMAGE;
const revision = process.env.COMPUTAH_REVISION;
if (!image?.startsWith("sha256:") || !/^[a-f0-9]{40}$/.test(revision ?? "")) {
  throw new Error(
    "An immutable local image ID and full Git revision are required",
  );
}

export default Alchemy.Stack(
  "computah",
  { providers: Docker.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const server = yield* Docker.Container("backend", {
      name: "computah-backend",
      image,
      start: true,
      restart: "unless-stopped",
      ports: [{ external: "127.0.0.1:8787", internal: 8787 }],
      envFiles: ["/etc/computah/runtime.env", "/etc/computah/provider.env"],
      environment: {
        PORT: "8787",
        HOME: "/data",
        NODE_ENV: "development",
        RIVET_RUN_ENGINE: "1",
        COMPUTAH_REVISION: revision as string,
      },
      volumes: [{ hostPath: "/var/lib/computah/data", containerPath: "/data" }],
      user: "1000:1000",
      capDrop: ["ALL"],
      noNewPrivileges: true,
      init: true,
      memory: "768m",
      pidsLimit: 256,
      stopTimeout: "60 seconds",
      logDriver: "local",
      logOptions: { "max-size": "5m", "max-file": "3" },
      labels: { "computah.revision": revision as string },
    });
    return { id: server.id, image, revision };
  }),
);
