'use strict';
// Native messaging framing: each message is a 4-byte little-endian length followed by UTF-8 JSON.
// Zen limits messages from the host to 1 MB; messages to the host can be much larger.
const { EventEmitter } = require('events');

const MAX_OUT = 1024 * 1024;

class NativeChannel extends EventEmitter {
  constructor(input, output) {
    super();
    this.out = output;
    this.buf = Buffer.alloc(0);
    input.on('data', chunk => this._onData(chunk));
    input.on('end', () => this.emit('end'));
    input.on('error', err => this.emit('end', err));
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
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
