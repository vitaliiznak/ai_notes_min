// The API's error codes. The web client imports these types too.

/** Why a model call failed. Adapters translate SDK errors into one of these. */
export type AiErrorCode = "timeout" | "rate_limited" | "unavailable" | "refused" | "invalid_output";

/** `error.code` of every error response. */
export type ErrorCode =
  | "validation_failed"
  | "invalid_json"
  | "payload_too_large"
  | "invalid_idempotency_key"
  | "idempotency_key_reused"
  | "invalid_regenerate"
  | "cross_site_request"
  | "not_found"
  | "note_too_short"
  | "database_unavailable"
  | "internal_error"
  | `ai_${AiErrorCode}`;
