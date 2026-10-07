# Deploy

The scripts run the same image Compose builds on a cluster: Postgres 17 on a 1Gi disk, one API replica serving the UI, and a GCE Ingress or Azure load balancer in front.

```sh
export OPENAI_API_KEY=sk-...   # or rely on .env; AI_PROVIDER=fake needs no key
./deploy/gke.sh                # GKE Autopilot, set up with gcloud
./deploy/tf.sh gcp             # the same on GKE, set up with Terraform
./deploy/tf.sh azure           # one AKS node and Azure Container Registry, set up with Terraform
```

**There is no login**, so anyone with the address can read and add notes. Don't give it a real domain before accounts exist.

- **Needs** `kubectl`, and `terraform` for `tf.sh`. Google Cloud: `gcloud`, a project with billing, and a login that can create clusters. Azure: `az`, as Owner or User Access Administrator, because the cluster is granted `AcrPull` on the registry.
- **What runs.** The scripts create what is missing (Google Cloud: APIs, Artifact Registry repo, Autopilot cluster, IAM for Cloud Build and image pulls; Azure: resource group, registry, AKS node), build the image tagged with the git commit (`TAG` overrides), and apply `deploy/k8s`, or `deploy/k8s/azure` on Azure. `--dry-run` prints the manifests without creating anything.
- **Settings.** `PROJECT_ID` (defaults to the current gcloud project) and `REGION` (`europe-west1`). On Azure: `AZURE_LOCATION` (`westeurope`), `ACR_NAME`, `DNS_PREFIX`.
- **Secret.** The first run creates the `ai-notes` secret with a generated database password and the API key. Later runs leave it alone, so the password keeps matching the existing disk. The key never enters Terraform state.
- **Use one script per GKE cluster.** Terraform does not adopt a cluster `gke.sh` created.
- **After deploy**, `kubectl -n ai-notes rollout status deploy/ai-notes` waits for `/api/health`. The address (the GKE ingress, or the Azure service's external IP) appears after a few minutes.
- **Timeouts.** The pod grace period and the load balancer timeouts are longer than the server's shutdown drain, so a slow AI call is not cut off. The manifests say why, and `server/test/openai.test.ts` fails if one drops below it.
- **Data** survives pod restarts. Deleting the namespace deletes the disk. To move to Cloud SQL, point `DATABASE_URL` at it and drop the StatefulSet; migrations run on boot.
- **Teardown:** `terraform destroy` in `deploy/terraform/gcp` or `deploy/terraform/azure`. State is local and gitignored.
