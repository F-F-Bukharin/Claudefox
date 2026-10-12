'use strict';
// Native messaging framing: each message is a 4-byte little-endian length followed by UTF-8 JSON.
// Zen limits messages from the host to 1 MB, so a reply over that is replaced by a short error with the same id: the
// add-on then learns the reply was lost, instead of waiting for it. A message to the host can be up to 64 MB. A bigger
// one is refused with a host_error, and its bytes are read off the pipe and dropped as they come, never kept in memory.
const { EventEmitter } = require('events');
const log = require('./log');

const MB = 1024 * 1024;
const MAX_OUT = MB;
const MAX_IN = 64 * MB;

class NativeChannel extends EventEmitter {
  constructor(input, output) {
    super();
    this.out = output;
    this.chunks = [];    // received bytes not used yet; joined only once a whole message is in (a message can be up to 64 MB)
    this.size = 0;
    this.need = null;    // body length of the message being received
    this.skip = 0;       // bytes of a refused body still to be thrown away
    input.on('data', chunk => this._onData(chunk));
    input.on('end', () => this.emit('end'));
    input.on('error', err => this.emit('end', err));
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - off);
      c.copy(out, off, 0, k);
      off += k;
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
    }
    this.size -= n;
    return out;
  }

  // Throws away up to n buffered bytes without copying them, and returns how many it threw away.
  _drop(n) {
    let left = n;
    while (left > 0 && this.chunks.length) {
      const c = this.chunks[0];
      const k = Math.min(c.length, left);
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
      left -= k;
    }
    this.size -= n - left;
    return n - left;
  }

  // A body over MAX_IN is refused at once: the add-on is told, and the body's bytes are dropped as they arrive (see _onData).
  _refuse(n) {
    const mb = Math.ceil(n / MB), limit = MAX_IN / MB;
    log.warn(`message from the add-on too large (${mb} MB, limit ${limit} MB): dropped`);
    this.skip = n;
    this.send({ type: 'host_error', error: `A message was too large (${mb} MB, limit ${limit} MB).` });
  }

  _onData(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      // A refused body is counted off the pipe and thrown away, so none of its bytes is kept.
      if (this.skip > 0) {
        this.skip -= this._drop(this.skip);
        if (this.skip > 0) return;
      }
      if (this.need === null) {
        if (this.size < 4) return;
        this.need = this._take(4).readUInt32LE(0);
        if (this.need > MAX_IN) { this._refuse(this.need); this.need = null; continue; }
      }
      if (this.size < this.need) return;
      const body = this._take(this.need);
      this.need = null;
      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch (e) { this.emit('bad', e); continue; }
      this.emit('message', msg);
    }
  }

  send(msg) {
    let body = Buffer.from(JSON.stringify(msg), 'utf8');
    let replaced = false;
    if (body.length > MAX_OUT) {
      // Zen cannot take a frame this big, so the add-on gets a short error with the same id instead of no answer at all.
      const mb = Math.ceil(body.length / MB);
      log.warn(`reply too large to send (${mb} MB): ${msg.type}`);
      const id = typeof msg.id === 'string' || typeof msg.id === 'number' ? msg.id : null;
      body = Buffer.from(JSON.stringify({ type: 'error', id, error: `The reply was too large to send (${mb} MB).` }), 'utf8');
      replaced = true;
    }
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.out.write(Buffer.concat([head, body]));
    // false: the message itself did not go (only the short error did), so a caller waiting for an answer to it fails now.
    return !replaced;
  }
}

module.exports = { NativeChannel, MAX_OUT, MAX_IN };
