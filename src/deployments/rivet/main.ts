import { registry } from "../../infrastructure/rivet/registry.js";
import {
  createNodeHttpServer,
  parsePort,
} from "../../infrastructure/node/http/server.js";
import { createApiHandler } from "../../entrypoints/api/handler.js";
import { createMcpHandler } from "../../entrypoints/mcp/handler.js";
import { createBearerAuthorizer } from "../../infrastructure/node/http/auth.js";
import { RivetJobGateway } from "../../infrastructure/rivet/JobGateway.js";
import {
  configureRivetJobs,
  configureRivetInference,
  configureRivetSubmissionPolicy,
} from "../../infrastructure/rivet/jobs.js";
import { createMetricsServer } from "../../infrastructure/node/http/metrics.js";
import { resolveRuntimeConcurrency } from "../../infrastructure/runtime/config.js";
import { resolveServerResourceLimits } from "../runtime-config.js";
import {
  createDeploymentModelGateway,
  resolveDeploymentModelConfig,
} from "../model-config.js";
import {
  EnvironmentCredentialsResolver,
  FallbackCredentialsResolver,
  type ProviderCredentials,
} from "../../infrastructure/model/CredentialsResolver.js";
import {
  configureRivetCredentials,
  RivetCredentialsResolver,
  type CredentialsActorClient,
} from "../../infrastructure/rivet/credentials.js";

const port = parsePort(process.env.PORT, 8080);
const metricsPort = parsePort(process.env.RIVETKIT_METRICS_PORT, 9464);
const concurrency = resolveRuntimeConcurrency(process.env);
configureRivetSubmissionPolicy({
  resourceCeilings: resolveServerResourceLimits(process.env),
});
const modelConfig = resolveDeploymentModelConfig(process.env);
console.info(
  `Scrub models configured: summary=${modelConfig.defaults.summary?.provider}/${modelConfig.defaults.summary?.model}, vision=${modelConfig.defaults.vision?.provider}/${modelConfig.defaults.vision?.model}`
);
configureRivetCredentials(process.env.RIVET_TOKEN);
const credentialSource = process.env.SCRUB_MODEL_CREDENTIAL_SOURCE ?? "rivet";
if (!["environment", "rivet"].includes(credentialSource))
  throw new Error("Invalid SCRUB_MODEL_CREDENTIAL_SOURCE");
configureRivetInference({
  defaults: modelConfig.defaults,
  resolveModels: async (context) => {
    const environment = new EnvironmentCredentialsResolver(() => process.env);
    const resolver =
      credentialSource === "environment"
        ? environment
        : new FallbackCredentialsResolver(
            environment,
            new RivetCredentialsResolver(
              () => context.client() as CredentialsActorClient,
              () => process.env.RIVET_TOKEN
            )
          );
    let credentials: ProviderCredentials = await resolver.resolve(
      context.abortSignal
    );
    return createDeploymentModelGateway(
      () => ({
        ...process.env,
        OPENAI_API_KEY: credentials.openai,
        ANTHROPIC_API_KEY: credentials.anthropic,
      }),
      async (operation) => {
        credentials = await resolver.resolve(operation.signal);
      }
    );
  },
});
configureRivetJobs(
  {
    stagingRoot: process.env.SCRUB_STAGING_ROOT ?? "/tmp/scrub",
    pythonPath: process.env.SCRUB_PYTHON_PATH ?? "/opt/venv/bin/python",
    providers: (
      process.env.SCRUB_TRANSCRIBERS ?? "youtube-captions,faster-whisper"
    ).split(","),
    openaiApiKey: process.env.OPENAI_API_KEY,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  },
  concurrency
);
console.info(
  `Scrub concurrency configured: request=${concurrency.requestDefault}, runner=${concurrency.runnerLimit}, global=${concurrency.globalLimit ?? "disabled"}`
);
const endpoint = process.env.RIVET_ENDPOINT;
const token = process.env.RIVET_TOKEN;
const apiToken = process.env.SCRUB_API_TOKEN ?? token;
const jobs =
  endpoint && token ? new RivetJobGateway({ endpoint, token }) : undefined;
const dependencies = {
  jobs,
  authorize: createBearerAuthorizer(apiToken),
};
const api = createApiHandler(dependencies);
const mcp = createMcpHandler({
  ...dependencies,
  allowedOrigins: process.env.SCRUB_PUBLIC_ORIGINS?.split(",").map(
    (origin) => new URL(origin.trim()).origin
  ),
});
const app = createNodeHttpServer((request) =>
  new URL(request.url).pathname === "/mcp" ? mcp.fetch(request) : api(request)
);
const metrics = createMetricsServer(() => registry.routes.prometheusMetrics());

const fail = () => {
  console.error("Scrub runner HTTP server failed to start");
  app.close();
  metrics.close();
  void Promise.all([mcp.close(), registry.shutdown()]).finally(() =>
    process.exit(1)
  );
};
app.on("error", fail);
metrics.on("error", fail);

registry.start();
app.listen(port, "0.0.0.0", () => {
  console.info(`Scrub HTTP server listening on port ${port}`);
});
metrics.listen(metricsPort, "127.0.0.1");
