'use strict';

const dgram = require('dgram');
const EventEmitter = require('events');
const { parseHepV3 } = require('./hepV3Parser');

const LOOPBACK = '127.0.0.1';
const DEFAULT_PORT = 9060;
const MAX_PENDING = 4096;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

class CallIntelligenceHepReceiver extends EventEmitter {
    constructor(options = {}) {
        super();

        this.host = options.host || LOOPBACK;
        this.port = Number(options.port || DEFAULT_PORT);
        this.expectedCaptureId = Number(options.captureId || 0);
        this.socket = null;
        this.started = false;
        this.closing = false;
        this.handler = null;
        this.queue = [];
        this.queueBytes = 0;
        this.maxPendingBytes = MAX_PENDING_BYTES;
        this.idleWaiters = new Set();
        this.processing = false;

        this.stats = {
            datagramsReceived: 0,
            datagramsParsed: 0,
            datagramsRejected: 0,
            datagramsFromOtherAddresses: 0,
            queueDrops: 0,
            captureIdRejected: 0,
            handlerErrors: 0,
            lastPacketAt: null,
            lastError: null
        };
    }

    async start(handler) {
        if (this.started) throw new Error('HEP receiver is already started.');
        if (typeof handler !== 'function') {
            throw new Error('HEP packet handler is required.');
        }
        if (this.host !== LOOPBACK) {
            throw new Error('HEP receiver must bind to 127.0.0.1 only.');
        }

        if (
            !Number.isSafeInteger(this.expectedCaptureId) ||
            this.expectedCaptureId < 1 ||
            this.expectedCaptureId > 4294967295
        ) {
            throw new Error('A valid expected HEP capture ID is required.');
        }

        this.handler = handler;
        this.closing = false;
        this.socket = dgram.createSocket('udp4');

        this.socket.on('error', error => {
            this.stats.lastError = error.message;
            this.emit('receiverError', error);
        });

        this.socket.on('message', (message, remote) => {
            this.stats.datagramsReceived++;
            this.stats.lastPacketAt = new Date();

            const address = String(remote.address || '');

            if (address !== LOOPBACK && address !== '::ffff:127.0.0.1') {
                this.stats.datagramsFromOtherAddresses++;
                return;
            }

            let packet;

            try {
                packet = parseHepV3(message);
                this.stats.datagramsParsed++;

                if (packet.captureId !== this.expectedCaptureId) {
                    this.stats.captureIdRejected++;
                    return;
                }
            } catch (error) {
                this.stats.datagramsRejected++;
                this.stats.lastError = error.message;
                this.emit('invalidPacket', {
                    code: error.code || 'HEP_INVALID_PACKET',
                    message: error.message
                });
                return;
            }

            if (
                this.queue.length >= MAX_PENDING ||
                this.queueBytes + message.length > this.maxPendingBytes
            ) {
                this.stats.queueDrops++;
                return;
            }

            this.queue.push({ packet, bytes: message.length });
            this.queueBytes += message.length;
            this.drain().catch(error => {
                this.stats.handlerErrors++;
                this.stats.lastError = error.message;
                this.emit('receiverError', error);
            });
        });

        await new Promise((resolve, reject) => {
            const onError = error => {
                this.socket.removeListener('listening', onListening);
                reject(error);
            };

            const onListening = () => {
                this.socket.removeListener('error', onError);
                resolve();
            };

            this.socket.once('error', onError);
            this.socket.once('listening', onListening);
            this.socket.bind(this.port, this.host);
        });

        this.started = true;
        this.emit('listening', {
            address: this.host,
            port: this.port
        });

        return {
            address: this.host,
            port: this.port
        };
    }

    async drain() {
        if (this.processing || this.closing) return;

        this.processing = true;

        try {
            while (this.queue.length && !this.closing) {
                const item = this.queue.shift();
                this.queueBytes = Math.max(0, this.queueBytes - item.bytes);

                try {
                    await this.handler(item.packet);
                } catch (error) {
                    this.stats.handlerErrors++;
                    this.stats.lastError = error.message;
                    this.emit('handlerError', error);
                }
            }
        } finally {
            this.processing = false;
            if (!this.queue.length) {
                for (const resolve of this.idleWaiters) resolve();
                this.idleWaiters.clear();
            }
        }
    }

    waitForIdle() {
        if (!this.processing && !this.queue.length) {
            return Promise.resolve();
        }

        return new Promise(resolve => this.idleWaiters.add(resolve));
    }

    getStats() {
        return {
            ...this.stats,
            queued: this.queue.length,
            queuedBytes: this.queueBytes,
            maxQueuedBytes: this.maxPendingBytes,
            listening: this.started,
            address: this.started ? this.host : null,
            port: this.started ? this.port : null
        };
    }

    async close() {
        if (!this.socket) return;

        const socket = this.socket;

        await new Promise(resolve => {
            try {
                socket.close(() => resolve());
            } catch (_) {
                resolve();
            }
        });

        this.socket = null;
        this.started = false;

        // Stop accepting datagrams first, then finish already queued work.
        await this.waitForIdle();
        this.closing = true;
        this.queue.length = 0;
        this.queueBytes = 0;
        this.emit('closed');
    }
}

module.exports = { CallIntelligenceHepReceiver };
