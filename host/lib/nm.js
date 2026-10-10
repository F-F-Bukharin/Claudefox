'use strict';
// Native messaging framing: each message is a 4-byte little-endian length followed by UTF-8 JSON.
// Zen limits messages from the host to 1 MB; messages to the host can be much larger.
const { EventEmitter } = require('events');

const MAX_OUT = 1024 * 1024;

class NativeChannel extends EventEmitter {
  constructor(input, output) {
    super();
    this.out = output;
    this.chunks = [];    // received bytes not used yet; joined only once a whole message is in (attachments can be 100 MB)
    this.size = 0;
    this.need = null;    // body length of the message being received
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

  _onData(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      if (this.need === null) {
        if (this.size < 4) return;
        this.need = this._take(4).readUInt32LE(0);
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
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    if (body.length > MAX_OUT) throw new Error(`message too large for Zen (${body.length} bytes)`);
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    this.out.write(Buffer.concat([head, body]));
  }
}

module.exports = { NativeChannel, MAX_OUT };
