import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";

export function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        url: "/api/openapi.json",
        pathRouting: { basePath: "#/api" },
        agent: { disabled: true },
        // The reference's server list overrides the document. Point it at this page so snippets and
        // Send use the API that is actually running, locally and on a deploy.
        servers: [{ url: window.location.origin }],
        // This origin serves the API. The hosted proxy cannot reach localhost or a private deploy,
        // and a proxied mutation fails the same-origin check.
        proxyUrl: "",
      }}
    />
  );
}
