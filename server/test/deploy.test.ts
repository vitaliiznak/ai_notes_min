import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { drainBudgetMs, loadConfig } from "../src/config.js";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const number = (text: string, pattern: RegExp) => Number(text.match(pattern)?.[1]);
const budget = drainBudgetMs(loadConfig({ AI_PROVIDER: "fake" }).AI_TIMEOUT_MS);

describe("deploy manifests", () => {
  it("keeps Compose stop_grace_period above the default drain budget", () => {
    expect(number(read("docker-compose.yml"), /stop_grace_period:\s*(\d+)s/) * 1000).toBeGreaterThan(budget);
  });

  it("keeps the GKE stop windows above the default drain budget", () => {
    const ingress = read("deploy/k8s/ingress.yaml");
    expect(number(read("deploy/k8s/app.yaml"), /terminationGracePeriodSeconds:\s*(\d+)/) * 1000).toBeGreaterThan(budget);
    expect(number(ingress, /^\s*timeoutSec:\s*(\d+)/m) * 1000).toBeGreaterThan(budget);
    expect(number(ingress, /drainingTimeoutSec:\s*(\d+)/) * 1000).toBeGreaterThan(budget);
  });

  it("keeps Postgres data off the cloud disk mount so initdb can run", () => {
    expect(read("deploy/k8s/postgres.yaml")).toContain("value: /var/lib/postgresql/data/pgdata");
  });

  it("keeps the Azure load balancer idle timeout above the default drain budget", () => {
    const service = read("deploy/k8s/azure/service.yaml");
    expect(number(service, /azure-load-balancer-tcp-idle-timeout:\s*"(\d+)"/) * 60 * 1000).toBeGreaterThan(budget);
    expect(service).toContain("service.beta.kubernetes.io/azure-load-balancer-health-probe-request-path: /api/health");
  });

  it("stores Azure Postgres on the managed-csi disk class", () => {
    expect(read("deploy/k8s/azure/storage.yaml")).toContain("value: managed-csi");
    expect(read("deploy/k8s/azure/kustomization.yaml")).not.toContain("ingress.yaml");
  });
});
