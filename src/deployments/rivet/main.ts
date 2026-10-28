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
  CREDENTIAL_SERVICES,
  MODEL_CREDENTIAL_SERVICES,
  type ProviderCredentials,
} from "../../infrastructure/model/CredentialsResolver.js";
import {
  configureRivetCredentials,
  RivetCredentialsResolver,
  type CredentialsActorClient,
} from "../../infrastructure/rivet/credentials.js";
import { LangSmithModelTracing } from "../../infrastructure/observability/LangSmithModelTracing.js";
import { resolveLangSmithTracingConfig } from "../tracing-config.js";
import { createNativeDiagnostics } from "../native-diagnostics.js";
import { configureRivetDiagnostics } from "../../infrastructure/rivet/diagnostics.js";

const port = parsePort(process.env.PORT, 8080);
const metricsPort = parsePort(process.env.RIVETKIT_METRICS_PORT, 9464);
const concurrency = resolveRuntimeConcurrency(process.env);
configureRivetSubmissionPolicy({
  resourceCeilings: resolveServerResourceLimits(process.env),
});
const modelConfig = resolveDeploymentModelConfig(process.env);
const tracingConfig = resolveLangSmithTracingConfig(process.env);
const credentialServices = tracingConfig.enabled
  ? CREDENTIAL_SERVICES
  : MODEL_CREDENTIAL_SERVICES;
let tracingCredentials: ProviderCredentials = {};
const tracing = new LangSmithModelTracing(() =>
  resolveLangSmithTracingConfig({
    ...process.env,
    OPENAI_API_KEY: tracingCredentials.openai ?? process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY:
      tracingCredentials.anthropic ?? process.env.ANTHROPIC_API_KEY,
    LANGSMITH_API_KEY:
      tracingCredentials.langsmith ?? process.env.LANGSMITH_API_KEY,
  })
);
console.info(
  `Scrub models configured: summary=${modelConfig.defaults.summary?.provider}/${modelConfig.defaults.summary?.model}, vision=${modelConfig.defaults.vision?.provider}/${modelConfig.defaults.vision?.model}`
);
configureRivetCredentials(process.env.RIVET_TOKEN);
configureRivetDiagnostics(process.env.RIVET_TOKEN);
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
              () => process.env.RIVET_TOKEN,
              credentialServices
            ),
            credentialServices
          );
    let credentials: ProviderCredentials = await resolver.resolve(
      context.abortSignal
    );
    tracingCredentials = credentials;
    return createDeploymentModelGateway(
      () => ({
        ...process.env,
        OPENAI_API_KEY: credentials.openai,
        ANTHROPIC_API_KEY: credentials.anthropic,
      }),
      async (operation) => {
        credentials = await resolver.resolve(operation.signal);
        tracingCredentials = credentials;
      },
      tracing
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
    diagnostics: createNativeDiagnostics(
      () => process.env,
      () =>
        Object.values(tracingCredentials).filter(
          (value): value is string => typeof value === "string"
        )
    ),
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

let closing: Promise<void> | undefined;
const close = () =>
  (closing ??= (async () => {
    const stopped = [app, metrics].map(
      (server) =>
        new Promise<void>((resolveClosed) =>
          server.close(() => resolveClosed())
        )
    );
    const force = setTimeout(() => {
      app.closeAllConnections();
      metrics.closeAllConnections();
    }, 5000);
    force.unref();
    try {
      const results = await Promise.allSettled([
        mcp.close(),
        registry.shutdown(),
        ...stopped,
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Scrub runner shutdown failed");
    } finally {
      clearTimeout(force);
      await tracing.flush();
    }
  })());
let failed = false;
const fail = () => {
  if (failed) return;
  failed = true;
  console.error("Scrub runner HTTP server failed to start");
  process.exitCode = 1;
  void close().catch(() => {
    process.exitCode = 1;
  });
};
app.on("error", fail);
metrics.on("error", fail);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (!failed) process.exitCode = signal === "SIGINT" ? 130 : 143;
    void close().catch(() => {
      process.exitCode = 1;
    });
  });

registry.start();
app.listen(port, "0.0.0.0", () => {
  console.info(`Scrub HTTP server listening on port ${port}`);
});
metrics.listen(metricsPort, "127.0.0.1");
