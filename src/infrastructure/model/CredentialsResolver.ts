export type ModelProvider = "openai" | "anthropic";
export type ProviderCredentials = Partial<Record<ModelProvider, string>>;

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
    };
  }
}

/** Explicit server environment takes precedence over the deployment credential Actor. */
export class FallbackCredentialsResolver implements CredentialsResolver {
  constructor(
    private readonly primary: CredentialsResolver,
    private readonly fallback: CredentialsResolver
  ) {}

  async resolve(signal?: AbortSignal): Promise<ProviderCredentials> {
    const primary = await this.primary.resolve(signal);
    if (primary.openai && primary.anthropic) return primary;
    let secondary: ProviderCredentials;
    try {
      secondary = await this.fallback.resolve(signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (primary.openai || primary.anthropic) return primary;
      throw error;
    }
    return { ...secondary, ...primary };
  }
}
