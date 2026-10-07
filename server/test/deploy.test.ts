import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { drainBudgetMs, loadConfig } from "../src/config.js";

describe("deploy manifests", () => {
  it("keeps Compose stop_grace_period above the default drain budget", () => {
    const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
    const seconds = Number(compose.match(/stop_grace_period:\s*(\d+)s/)?.[1]);
    const timeoutMs = loadConfig({ AI_PROVIDER: "fake" }).AI_TIMEOUT_MS;
    expect(seconds * 1000).toBeGreaterThan(drainBudgetMs(timeoutMs));
  });

  it("keeps the GKE stop windows above the default drain budget", () => {
    const app = readFileSync(new URL("../../deploy/k8s/app.yaml", import.meta.url), "utf8");
    const ingress = readFileSync(new URL("../../deploy/k8s/ingress.yaml", import.meta.url), "utf8");
    const grace = Number(app.match(/terminationGracePeriodSeconds:\s*(\d+)/)?.[1]);
    const backend = Number(ingress.match(/^\s*timeoutSec:\s*(\d+)/m)?.[1]);
    const draining = Number(ingress.match(/drainingTimeoutSec:\s*(\d+)/)?.[1]);
    const budget = drainBudgetMs(loadConfig({ AI_PROVIDER: "fake" }).AI_TIMEOUT_MS);
    expect(grace * 1000).toBeGreaterThan(budget);
    expect(backend * 1000).toBeGreaterThan(budget);
    expect(draining * 1000).toBeGreaterThan(budget);
  });

  it("keeps Postgres data off the cloud disk mount so initdb can run", () => {
    const postgres = readFileSync(new URL("../../deploy/k8s/postgres.yaml", import.meta.url), "utf8");
    expect(postgres).toContain("value: /var/lib/postgresql/data/pgdata");
  });

  it("keeps the Azure load balancer idle timeout above the default drain budget", () => {
    const service = readFileSync(new URL("../../deploy/k8s/azure/service.yaml", import.meta.url), "utf8");
    const minutes = Number(service.match(/azure-load-balancer-tcp-idle-timeout:\s*"(\d+)"/)?.[1]);
    const budget = drainBudgetMs(loadConfig({ AI_PROVIDER: "fake" }).AI_TIMEOUT_MS);
    expect(minutes * 60 * 1000).toBeGreaterThan(budget);
    expect(service).toContain("service.beta.kubernetes.io/azure-load-balancer-health-probe-request-path: /api/health");
  });

  it("stores Azure Postgres on the managed-csi disk class", () => {
    const storage = readFileSync(new URL("../../deploy/k8s/azure/storage.yaml", import.meta.url), "utf8");
    const azure = readFileSync(new URL("../../deploy/k8s/azure/kustomization.yaml", import.meta.url), "utf8");
    expect(storage).toContain("value: managed-csi");
    expect(azure).not.toContain("ingress.yaml");
  });
});
