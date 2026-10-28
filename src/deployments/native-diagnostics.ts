import {
  sanitizeNativeCommandDiagnostic,
  type NativeCommandDiagnostic,
} from "../infrastructure/node/diagnostics.js";
import type { NativeDiagnosticsOptions } from "../infrastructure/node/runtime.js";

/** Composition supplies secret sources; native adapters never discover environment values. */
export function createNativeDiagnostics(
  environment: () => Record<string, string | undefined>,
  additionalSecrets: () => readonly string[] = () => [],
  write: (event: NativeCommandDiagnostic) => void | Promise<void> = (event) =>
    console.warn(JSON.stringify(event))
): NativeDiagnosticsOptions {
  const redactValues = () => [
    ...new Set(
      [
        ...Object.entries(environment())
          .filter(([name]) =>
            /(?:^|_)(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|COOKIES?)(?:$|_)/.test(
              name
            )
          )
          .flatMap(([, value]) =>
            value === undefined ? [] : [value, value.trim()]
          ),
        ...additionalSecrets().flatMap((value) => [value, value.trim()]),
      ].filter((value) => value.length >= 8)
    ),
  ];
  return {
    redactValues,
    emit(event) {
      const safe = sanitizeNativeCommandDiagnostic(event, redactValues());
      if (safe) return write(safe);
    },
  };
}
