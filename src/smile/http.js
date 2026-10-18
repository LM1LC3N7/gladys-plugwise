// -----------------------------------------------------------------------------
// The only network access of the integration: one plain HTTP request to the
// Smile on node:http (the Smile serves its local API on port 80, without
// TLS). A deadline for the whole exchange, a size cap on the body read, no
// redirect followed, no keep-alive. Resolves { status, headers, body } for any
// status; rejects a SmileError for the transport failures.
//
// `sendWithin`: the connection must be up within this many ms, else nothing
// is written (a command never leaves late). `onSent` is called once the
// connection is up: from then on, the request may have reached the Smile.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { CODES, SmileError } from './errors.js';

function transportError(err) {
  const code = String(err?.code ?? '');
  // Something answered, but not in HTTP (a wrong port).
  if (code.startsWith('HPE_')) return new SmileError(CODES.BAD_ANSWER, `Not HTTP (${code})`);
  // Only the error code: a message may carry an address or a header value.
  return new SmileError(CODES.UNREACHABLE, code || 'Connection failed');
}

/**
 * @param {string} url absolute http URL
 * @param {object} options
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.onSent] called once the connection is up
 */
export function httpRequest(
  url,
  { method = 'GET', headers = {}, body, timeout, sendWithin, maxBytes, onSent } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;
    let req = null;
    // Until the connection is up, nothing of the request has left: a failure
    // then is "not sent" for sure (see the commands).
    let connected = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        if (!connected) error.notSent = true;
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(new SmileError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`)),
      timeout,
    );
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(() => {
            if (!connected) {
              finish(new SmileError(CODES.TIMEOUT, 'Not connected in time: request not sent'));
            }
          }, sendWithin);

    const markSent = () => {
      if (connected) return;
      connected = true;
      clearTimeout(sendTimer);
      onSent?.();
    };

    try {
      const payload = body === undefined ? undefined : Buffer.from(body, 'utf8');
      req = http.request(
        {
          method,
          host: target.hostname.replace(/^\[(.*)\]$/, '$1'),
          port: Number(target.port) || 80,
          path: `${target.pathname}${target.search}`,
          agent: false,
          headers: {
            accept: 'text/xml',
            host: target.host,
            connection: 'close',
            ...(payload ? { 'content-type': 'text/xml', 'content-length': payload.length } : {}),
            ...headers,
          },
        },
        (res) => {
          markSent();
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              finish(new SmileError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (err) => finish(transportError(err)));
        },
      );
      req.on('socket', (socket) => {
        if (!socket.connecting) markSent();
        else socket.once('connect', markSent);
      });
      req.on('error', (err) => finish(transportError(err)));
      req.end(payload);
    } catch (err) {
      // http.request throws on a header it refuses: a failure, never a crash.
      finish(transportError(err));
    }
  });
}
