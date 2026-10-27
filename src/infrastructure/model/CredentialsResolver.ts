export type ModelProvider = "openai" | "anthropic";
export type CredentialService = ModelProvider | "langsmith";
export const MODEL_CREDENTIAL_SERVICES: readonly ModelProvider[] = [
  "openai",
  "anthropic",
];
export const CREDENTIAL_SERVICES: readonly CredentialService[] = [
  ...MODEL_CREDENTIAL_SERVICES,
  "langsmith",
];
/** Server-only credentials; the model protocol registry still has two providers. */
export type ProviderCredentials = Partial<Record<CredentialService, string>>;

/** Server-only source. Credentials never enter application settings or artifacts. */
export interface CredentialsResolver {
  resolve(signal?: AbortSignal): Promise<ProviderCredentials>;
}

export class EnvironmentCredentialsResolver implements CredentialsResolver {
  constructor(
    private readonly environment: () => Record<string, string | undefined>
  ) {}

  async resolve(signal?: AbortSignal): Promise<ProviderCredentials> {
    signal?.throwIfAborted();
    const environment = this.environment();
    return {
      ...(environment.OPENAI_API_KEY?.trim()
        ? { openai: environment.OPENAI_API_KEY.trim() }
        : {}),
      ...(environment.ANTHROPIC_API_KEY?.trim()
        ? { anthropic: environment.ANTHROPIC_API_KEY.trim() }
        : {}),
      ...(environment.LANGSMITH_API_KEY?.trim()
        ? { langsmith: environment.LANGSMITH_API_KEY.trim() }
        : {}),
    };
  }
}

/** Explicit server environment takes precedence over the deployment credential Actor. */
export class FallbackCredentialsResolver implements CredentialsResolver {
  private readonly requestedServices: readonly CredentialService[];

  constructor(
    private readonly primary: CredentialsResolver,
    private readonly fallback: CredentialsResolver,
    requestedServices: readonly CredentialService[] = MODEL_CREDENTIAL_SERVICES
  ) {
    this.requestedServices = [...requestedServices];
  }

  async resolve(signal?: AbortSignal): Promise<ProviderCredentials> {
    const primary = await this.primary.resolve(signal);
    if (this.requestedServices.every((service) => primary[service]))
      return primary;
    let secondary: ProviderCredentials;
    try {
      secondary = await this.fallback.resolve(signal);
    } catch (error) {
      signal?.throwIfAborted();
      // An optional tracing key alone cannot hide a model credential outage.
      if (primary.openai || primary.anthropic) return primary;
      throw error;
    }
    return { ...secondary, ...primary };
  }
}
