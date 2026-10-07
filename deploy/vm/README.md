# Password-protected Azure VM

The VM runs the app and Postgres on a private Docker network. Caddy is the only published service (80/443), redirects HTTP to HTTPS, obtains/renews the certificate, and requires a shared username/password on every HTTPS path, including the API and health endpoint. The app and database have no host port mapping. Anyone with the password shares the same notebook and can permanently delete notes.

Copy `compose.yaml` and `Caddyfile` from this directory into the application root on the VM. Keep the Compose project name `ai-notes` when updating the existing deployment so its `ai-notes_pgdata` volume is reused. Do not run `down -v`.

Before running `docker compose -p ai-notes up -d --build`, supply:

- `DB_PASSWORD`: the existing database password (do not regenerate on redeploy).
- `SITE_HOST`: a DNS name resolving to the VM, with ports 80 and 443 allowed.
- `APP_USER` and `APP_PASSWORD_HASH`: a shared username and the output of `caddy hash-password` (bcrypt, never a plaintext password).
- `AI_PROVIDER`: defaults to `fake`; OpenAI also needs `OPENAI_API_KEY` and optionally `OPENAI_MODEL`.

Keep secrets outside Git and Docker build context. Persist Caddy's data volume for certificate renewal. Only share the HTTPS hostname, never credentials in a URL. Browser Basic authentication remains cached until the browser clears it or exits; there is no app logout or per-user account system.

After deployment, verify HTTP redirects, unauthenticated and incorrect-password requests return 401, correct credentials can load the UI/API, and ports 3000/5432 are not public. Test deletion with disposable notes; deleting all existing notes is a separate user action.
