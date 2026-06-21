// Minimal zero-dependency WebSocket server (RFC 6455).
// Only what we need: text frames, ping/pong, close. No extensions, no fragmentation reassembly
// beyond buffering. Good enough for a game prototype.
const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function makeAcceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// Encode a server->client frame (unmasked). opcode 0x1 = text, 0x8 = close, 0xA = pong.
function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._die());
    socket.on('error', () => this._die());
  }

  _die() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  send(str) {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(str, 0x1));
    } catch (e) { this._die(); }
  }

  close() {
    if (this.closed) return;
    try { this.socket.write(encodeFrame(Buffer.alloc(0), 0x8)); } catch (e) {}
    try { this.socket.end(); } catch (e) {}
    this._die();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Parse as many complete frames as are available.
    while (true) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        // ignore high 32 bits (we never send anything that big)
        len = this.buffer.readUInt32BE(6);
        offset = 10;
      }
      let maskKey;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return; // wait for full payload
      let payload = this.buffer.slice(offset, offset + len);
      if (masked) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i & 3];
        payload = out;
      }
      this.buffer = this.buffer.slice(offset + len);

      if (opcode === 0x8) { // close
        this.close();
        return;
      } else if (opcode === 0x9) { // ping -> pong
        try { this.socket.write(encodeFrame(payload, 0xA)); } catch (e) {}
      } else if (opcode === 0x1 || opcode === 0x2) { // text/binary
        this.emit('message', payload.toString('utf8'));
      }
      // ignore pong (0xA) and continuation (0x0) for simplicity
    }
  }
}

// Attach to an http.Server: handles the upgrade handshake, calls onConn(conn).
function attach(server, onConn) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = makeAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const conn = new Conn(socket);
    onConn(conn);
  });
}

module.exports = { attach };
