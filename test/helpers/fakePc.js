// -----------------------------------------------------------------------------
// A fake PC behind the client interface of src/bridge/client.js (getData,
// command, disconnect, dispose), for the tests of the app: no socket, every
// outcome chosen by the test.
// -----------------------------------------------------------------------------

import { BridgeError, CODES } from '../../src/bridge/errors.js';
import { ANSWERS, windowsModules } from './fakeBridge.js';

/**
 * @param {object} [options]
 * @param {object} [options.modules]
 */
export function createFakePc({ modules = windowsModules() } = {}) {
  const pc = {
    modules,
    /** A BridgeError every reading throws, or null. */
    fail: null,
    /** 'answer' | 'silent' | 'refused' | 'notSent' | 'badToken' */
    commands: 'answer',
    /** Called during each reading (the test changes things meanwhile). */
    onRead: null,
    reads: [],
    sent: [],
    clients: [],
  };
  pc.createClient = (options) => {
    const client = {
      options,
      disposed: false,
      async getData(names) {
        pc.reads.push([...names]);
        await pc.onRead?.(names);
        if (client.disposed) throw new BridgeError(CODES.CLOSED, 'configuration changed');
        if (pc.fail) throw pc.fail;
        const out = {};
        for (const name of names) if (name in pc.modules) out[name] = pc.modules[name];
        return out;
      },
      async command(event, data, answer) {
        if (pc.commands === 'notSent')
          throw new BridgeError(CODES.CLOSED, 'closed', { sent: false });
        pc.sent.push({ event, data });
        if (answer !== ANSWERS[event]) throw new Error(`unexpected answer type ${answer}`);
        if (pc.commands === 'silent')
          throw new BridgeError(CODES.TIMEOUT, 'no answer', { sent: true });
        if (pc.commands === 'refused') {
          throw new BridgeError(CODES.REFUSED, 'refused', { subtype: 'BAD_REQUEST', sent: true });
        }
        if (pc.commands === 'badToken') throw new BridgeError(CODES.BAD_TOKEN, 'token refused');
        return { type: answer };
      },
      disconnect() {},
      dispose() {
        client.disposed = true;
      },
    };
    pc.clients.push(client);
    return client;
  };
  return pc;
}
