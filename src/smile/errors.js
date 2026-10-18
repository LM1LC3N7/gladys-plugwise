// -----------------------------------------------------------------------------
// SmileError: every failure of a request to the Smile, with a code the app
// maps to a status, a retry policy or a message. Messages are built from codes
// and HTTP statuses only: never the text of an answer, never the Smile ID.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  TIMEOUT: 'timeout', // no answer in time
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  BAD_ANSWER: 'bad_answer', // not the XML of a Smile
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
  NO_TIME: 'no_time', // the deadline of a command left no room: not sent
});

export class SmileError extends Error {
  constructor(code, message, { status, retryAfterMs, notSent } = {}) {
    super(message);
    this.name = 'SmileError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    if (notSent) this.notSent = true;
  }
}

/** The Smile refused the Smile ID (HTTP 401). */
export const isAuthRefused = (err) => err?.code === CODES.HTTP && err.status === 401;
