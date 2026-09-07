/** Error metadata exposed by the platform APIs and consumed by retry policy. */
export interface PlatformError extends Error {
  code?: number | string; status?: number; statusCode?: number; error_code?: number;
  description?: string; msg?: string; data?: ApiEnvelope; response?: {status?: number; data?: ApiEnvelope};
  fallbackSafe?: boolean; deliveryUncertain?: boolean;
}
export interface ApiEnvelope { code?: number | string; msg?: string; message?: string; data?: ApiEnvelope }
export function platformError(value: unknown): PlatformError {
  return value instanceof Error || (value !== null && typeof value === 'object')
    ? value as PlatformError : new Error(String(value));
}
