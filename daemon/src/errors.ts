export class DaemonError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status = 400, message = code) {
    super(message)
    this.name = "DaemonError"
    this.code = code
    this.status = status
  }
}

export function asDaemonError(error: unknown): DaemonError {
  if (error instanceof DaemonError) return error
  return new DaemonError("daemon_unavailable", 500, "daemon_unavailable")
}
