// -----------------------------------------------------------------------------
// A fake Smile behind the HTTP transport of src/smile/http.js: it serves an
// XML document (a python-plugwise fixture, changed by the test at will) and
// records every request. No test touches the network.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { CODES, SmileError } from '../../src/smile/errors.js';

export const fixture = (name) =>
  readFileSync(new URL(`../fixtures/${name}.xml`, import.meta.url), 'utf8');

/** The time of the Smile in its answer: its measurements are fresh then. */
export const timeOf = (xml) => Date.parse(/<time>([^<]+)<\/time>/.exec(xml)?.[1] ?? '');

export function createFakeSmile(xml) {
  const smile = {
    xml,
    calls: [],
    /** Called on every GET before answering (may change the clock, the config...). */
    onGet: null,
    /** Replace the GET answer: () => { status, headers, body } or throws. */
    getAnswer: null,
    /** Whether a PUT gets connected (onSent) before its answer. */
    putConnects: true,
    /** The PUT answer: (call) => { status } | Promise (never resolving: no answer). */
    putAnswer: () => ({ status: 202, headers: {}, body: Buffer.alloc(0) }),
    get gets() {
      return smile.calls.filter((c) => c.method === 'GET');
    },
    get puts() {
      return smile.calls.filter((c) => c.method === 'PUT');
    },
    async request(url, options) {
      const call = { url, path: new URL(url).pathname, ...options };
      smile.calls.push(call);
      if (call.method === 'GET') {
        await smile.onGet?.(call);
        if (smile.getAnswer) return smile.getAnswer(call);
        return { status: 200, headers: {}, body: Buffer.from(smile.xml, 'utf8') };
      }
      if (smile.putConnects) options.onSent?.();
      return smile.putAnswer(call);
    },
  };
  smile.request = smile.request.bind(smile);
  return smile;
}

export const unreachable = () => {
  const err = new SmileError(CODES.UNREACHABLE, 'ECONNREFUSED');
  err.notSent = true;
  return err;
};
