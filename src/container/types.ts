/** Result shape returned by text-editing tool operations. */
export interface EditResult {
  ok: boolean
  message: string
}

/** Normalized image payload ready for model input. */
export interface ModelImageInput {
  path: string
  mime: string
  bytes: number
  dataUrl: string
}

/** Options for the low-level PTY command runner. */
export interface RunRawOptions {
  timeoutMs?: number
  redirectStdinToDevNull?: boolean
}

/** JSON payload contract emitted by the in-container image helper script. */
export interface ImageToolPayload {
  ok?: boolean
  message?: string
  path?: string
  mime?: string
  bytes?: number
  data_url?: string
}
