// -----------------------------------------------------------------------------
// Errors of the System Bridge connection. The message never holds the token
// nor anything System Bridge sent (it may be logged and shown in Gladys).
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  /** TCP refused, host unknown or unreachable: the PC is off, asleep or away. */
  UNREACHABLE: 'UNREACHABLE',
  /** No connection or no answer in time. */
  TIMEOUT: 'TIMEOUT',
  /** The upgrade was answered with an HTTP status (not 101). */
  HTTP: 'HTTP',
  /** Not a WebSocket answer, a protocol error, or not System Bridge. */
  BAD_ANSWER: 'BAD_ANSWER',
  /** A message larger than allowed. */
  TOO_LARGE: 'TOO_LARGE',
  /** System Bridge refused the token (BAD_TOKEN). */
  BAD_TOKEN: 'BAD_TOKEN',
  /** System Bridge answered with an error to this request. */
  REFUSED: 'REFUSED',
  /** The connection closed (by System Bridge, or by a new configuration). */
  CLOSED: 'CLOSED',
  /** Too many requests waiting for an answer. */
  BUSY: 'BUSY',
});

export class BridgeError extends Error {
  /**
   * @param {string} code one of CODES
   * @param {string} message
   * @param {{ status?: number, retryAfterMs?: number, subtype?: string, sent?: boolean }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.subtype = details.subtype;
    /** The request was written on the socket before the failure (a command may have run). */
    this.sent = details.sent === true;
  }
}

export const isTokenRefused = (err) => err?.code === CODES.BAD_TOKEN;

/** The subtypes System Bridge (5.x, and the connector) use for a wrong token. */
export const TOKEN_SUBTYPES = Object.freeze(['BAD_TOKEN', 'BAD_API_KEY', 'MISSING_TOKEN']);
