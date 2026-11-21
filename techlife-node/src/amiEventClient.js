'use strict';

const net = require('net');
const EventEmitter = require('events');

const ALLOWED_EVENTS = new Set([
    'Newchannel',
    'Newstate',
    'Hangup',
    'DialBegin',
    'DialEnd',
    'BridgeEnter',
    'BridgeLeave',
    'Rename',
    'DTMFBegin',
    'DTMFEnd',
    'VarSet'
]);

const MAX_FRAME_BYTES = 1024 * 1024;

function parseFrame(frame) {
    const result = Object.create(null);

    for (const line of frame.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;

        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();

        if (!key) continue;

        // AMI may repeat headers. Preserve repeated values as arrays.
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            if (Array.isArray(result[key])) {
                result[key].push(value);
            } else {
                result[key] = [result[key], value];
            }
        } else {
            result[key] = value;
        }
    }

    return result;
}

function valueOf(frame, key) {
    const value = frame[key];
    return Array.isArray(value) ? value[0] : value;
}

class AmiEventClient extends EventEmitter {
    constructor(options = {}) {
        super();

        this.host = options.host || '127.0.0.1';
        this.port = Number(options.port || 5038);
        this.username = options.username;
        this.secret = options.secret;
        this.timeoutMs = Number(options.timeoutMs || 8000);

        this.socket = null;
        this.buffer = '';
        this.connected = false;
        this.closing = false;
    }

    connect() {
        if (this.socket) {
            return Promise.reject(new Error('AMI socket already exists.'));
        }

        if (!this.username || !this.secret) {
            return Promise.reject(new Error('AMI credentials are missing.'));
        }

        return new Promise((resolve, reject) => {
            let settled = false;

            const socket = net.createConnection({
                host: this.host,
                port: this.port
            });

            this.socket = socket;
            this.buffer = '';
            this.closing = false;

            socket.setNoDelay(true);
            socket.setKeepAlive(true, 30000);

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('AMI login timed out.'));
                    socket.destroy();
                }
            }, this.timeoutMs);

            const settle = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);

                if (error) {
                    reject(error);
                } else {
                    this.connected = true;
                    resolve();
                }
            };

            socket.on('connect', () => {
                // Asterisk accepts the Login action immediately after TCP
                // connect; the welcome banner does not require a blank line.
                socket.write(
                    'Action: Login\r\n' +
                    `Username: ${this.username}\r\n` +
                    `Secret: ${this.secret}\r\n` +
                    'Events: call,dtmf,dialplan\r\n\r\n'
                );
            });

            socket.on('data', chunk => {
                this.buffer += chunk.toString('utf8');

                if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) {
                    const error = new Error('AMI input buffer exceeded its limit.');
                    settle(error);
                    socket.destroy();
                    return;
                }

                let boundary;
                while ((boundary = this.buffer.indexOf('\r\n\r\n')) >= 0) {
                    const rawFrame = this.buffer.slice(0, boundary);
                    this.buffer = this.buffer.slice(boundary + 4);

                    const frame = parseFrame(rawFrame);
                    const response = valueOf(frame, 'Response');
                    const message = valueOf(frame, 'Message');
                    const eventName = valueOf(frame, 'Event');

                    if (response === 'Success' &&
                        /Authentication accepted/i.test(message || '')) {
                        settle(null);
                        continue;
                    }

                    if (response === 'Error') {
                        const error = new Error(
                            `Asterisk rejected AMI request: ${String(message || 'unknown error').slice(0, 200)}`
                        );
                        settle(error);
                        socket.destroy();
                        return;
                    }

                    if (eventName && ALLOWED_EVENTS.has(eventName)) {
                        this.emit('event', frame);
                    }
                }
            });

            socket.on('error', error => {
                if (!settled) {
                    settle(error);
                } else {
                    this.emit('socketError', error);
                }
            });

            socket.on('close', hadError => {
                this.connected = false;
                this.socket = null;
                this.buffer = '';

                if (!settled) {
                    settle(new Error(
                        hadError
                            ? 'AMI socket closed during login.'
                            : 'AMI socket closed before login completed.'
                    ));
                }

                this.emit('disconnect', {
                    intentional: this.closing,
                    hadError: Boolean(hadError)
                });
            });
        });
    }

    close() {
        this.closing = true;

        const socket = this.socket;
        if (!socket) return;

        if (this.connected && !socket.destroyed) {
            // Logoff is the only AMI action sent after login.
            socket.write('Action: Logoff\r\n\r\n');
            socket.end();
        } else {
            socket.destroy();
        }
    }
}

module.exports = {
    AmiEventClient,
    ALLOWED_EVENTS,
    parseFrame
};
