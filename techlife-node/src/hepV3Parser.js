'use strict';

const net = require('net');

const MAX_PACKET_BYTES = 262144;
const PROTOCOL = Object.freeze({
    SIP: 1,
    H323: 2,
    SDP: 3,
    RTP: 4,
    RTCP: 5
});

function fail(message) {
    const error = new Error(message);
    error.code = 'HEP_INVALID_PACKET';
    throw error;
}

function ipv4(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 4) return null;
    return [...buffer].join('.');
}

function ipv6(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length !== 16) return null;

    const words = [];
    for (let i = 0; i < 16; i += 2) {
        words.push(buffer.readUInt16BE(i).toString(16));
    }

    // Compress the longest run of zero words.
    let bestStart = -1;
    let bestLength = 1;

    for (let i = 0; i < words.length;) {
        if (words[i] !== '0') {
            i++;
            continue;
        }

        let j = i;
        while (j < words.length && words[j] === '0') j++;

        if (j - i > bestLength) {
            bestStart = i;
            bestLength = j - i;
        }
        i = j;
    }

    if (bestStart < 0) return words.join(':');

    const left = words.slice(0, bestStart).join(':');
    const right = words.slice(bestStart + bestLength).join(':');

    return `${left}::${right}`;
}

function decodeChunk(vendor, id, value, result) {
    // Standard HEP generic chunks use vendor ID 0.
    if (vendor !== 0) return;

    switch (id) {
        case 0x0001:
            if (value.length === 1) result.ipFamily = value[0];
            break;
        case 0x0002:
            if (value.length === 1) result.transportProtocol = value[0];
            break;
        case 0x0003:
            if (value.length === 4) result.sourceIp = ipv4(value);
            break;
        case 0x0004:
            if (value.length === 4) result.destinationIp = ipv4(value);
            break;
        case 0x0005:
            if (value.length === 16) result.sourceIp = ipv6(value);
            break;
        case 0x0006:
            if (value.length === 16) result.destinationIp = ipv6(value);
            break;
        case 0x0007:
            if (value.length === 2) result.sourcePort = value.readUInt16BE(0);
            break;
        case 0x0008:
            if (value.length === 2) result.destinationPort = value.readUInt16BE(0);
            break;
        case 0x0009:
            if (value.length === 4) result.timestampSeconds = value.readUInt32BE(0);
            break;
        case 0x000a:
            if (value.length === 4) result.timestampMicroseconds = value.readUInt32BE(0);
            break;
        case 0x000b:
            if (value.length === 1) result.protocolType = value[0];
            break;
        case 0x000c:
            if (value.length === 4) result.captureId = value.readUInt32BE(0);
            break;
        case 0x000e:
            // Do not log or expose the authentication value.
            result.hasAuthenticationChunk = value.length > 0;
            break;
        case 0x000f:
            result.payload = Buffer.from(value);
            break;
        case 0x0011:
            // Common correlation UUID extension.
            result.correlationId = value.toString('utf8').trim();
            break;
        default:
            break;
    }
}

function parseSIP(payload) {
    if (!Buffer.isBuffer(payload)) return null;

    const text = payload.toString('utf8');
    const firstLine = text.split(/\r?\n/, 1)[0].trim();

    let method = null;
    let statusCode = null;
    let reason = null;
    let requestUri = null;

    const request = firstLine.match(
        /^([A-Z][A-Z0-9_.!%*+`'~-]*)\s+(\S+)\s+SIP\/2\.0$/i
    );

    const response = firstLine.match(
        /^SIP\/2\.0\s+([1-6]\d\d)(?:\s+(.*))?$/i
    );

    if (request) {
        method = request[1].toUpperCase();
        requestUri = request[2];
    } else if (response) {
        statusCode = Number(response[1]);
        reason = response[2] || '';
    } else {
        return null;
    }

    const unfolded = text.replace(/\r?\n[ \t]+/g, ' ');
    const headers = {};

    for (const line of unfolded.split(/\r?\n/).slice(1)) {
        if (!line) break;

        const colon = line.indexOf(':');
        if (colon <= 0) continue;

        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();

        if (headers[name] === undefined) {
            headers[name] = value;
        }
    }

    return {
        method,
        statusCode,
        reason,
        requestUri,
        callId: headers['call-id'] || headers['i'] || null,
        cseq: headers.cseq || null,
        fromUri: headers.from || headers.f || null,
        toUri: headers.to || headers.t || null
    };
}

function parseHepV3(buffer) {
    if (!Buffer.isBuffer(buffer)) fail('Datagram is not a Buffer.');
    if (buffer.length < 6) fail('HEP header is truncated.');
    if (buffer.length > MAX_PACKET_BYTES) fail('HEP datagram exceeds size limit.');
    if (buffer.toString('ascii', 0, 4) !== 'HEP3') {
        fail('Invalid HEPv3 protocol identifier.');
    }

    const totalLength = buffer.readUInt16BE(4);

    if (totalLength < 6) fail('Invalid HEP total length.');
    if (totalLength !== buffer.length) {
        fail('HEP length does not match datagram length.');
    }

    const result = {
        version: 3,
        ipFamily: null,
        transportProtocol: null,
        sourceIp: null,
        destinationIp: null,
        sourcePort: null,
        destinationPort: null,
        timestampSeconds: null,
        timestampMicroseconds: 0,
        protocolType: null,
        captureId: null,
        correlationId: null,
        hasAuthenticationChunk: false,
        payload: null
    };

    let offset = 6;

    while (offset < totalLength) {
        if (offset + 6 > totalLength) {
            fail('HEP chunk header is truncated.');
        }

        const vendor = buffer.readUInt16BE(offset);
        const id = buffer.readUInt16BE(offset + 2);
        const chunkLength = buffer.readUInt16BE(offset + 4);

        if (chunkLength < 6 || offset + chunkLength > totalLength) {
            fail('Invalid HEP chunk length.');
        }

        const value = buffer.subarray(offset + 6, offset + chunkLength);
        decodeChunk(vendor, id, value, result);
        offset += chunkLength;
    }

    if (![2, 10].includes(result.ipFamily)) {
        fail('Unsupported or missing HEP IP family.');
    }

    if (![6, 17].includes(result.transportProtocol)) {
        fail('Unsupported or missing HEP transport protocol.');
    }

    if (![PROTOCOL.SIP, PROTOCOL.RTCP].includes(result.protocolType)) {
        fail('Unsupported HEP payload protocol.');
    }

    if (!result.payload || result.payload.length === 0) {
        fail('HEP payload is missing.');
    }

    if (result.payload.length > MAX_PACKET_BYTES) {
        fail('HEP payload exceeds storage size limit.');
    }

    if (!result.sourceIp || !result.destinationIp ||
        !result.sourcePort || !result.destinationPort) {
        fail('HEP network endpoint fields are incomplete.');
    }

    if (result.timestampSeconds !== null) {
        const micros = Math.min(
            Math.max(result.timestampMicroseconds || 0, 0),
            999999
        );

        result.packetTime = new Date(
            result.timestampSeconds * 1000 + Math.floor(micros / 1000)
        );
    } else {
        result.packetTime = null;
    }

    result.recordType =
        result.protocolType === PROTOCOL.SIP ? 'sip' : 'rtcp';

    result.sip = result.recordType === 'sip'
        ? parseSIP(result.payload)
        : null;

    if (result.recordType === 'sip' && !result.sip) {
        fail('HEP SIP payload does not contain a valid SIP start line.');
    }

    return result;
}

module.exports = {
    parseHepV3,
    parseSIP,
    PROTOCOL,
    MAX_PACKET_BYTES
};
