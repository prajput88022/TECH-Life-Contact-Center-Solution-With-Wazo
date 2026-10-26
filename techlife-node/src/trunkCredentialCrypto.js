'use strict';
const crypto = require('crypto');

function key() {
  const raw = process.env.TRUNK_CREDENTIALS_KEY;
  if (!raw || !/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error('TRUNK_CREDENTIALS_KEY must be a persistent 64-character hex key');
  }
  return Buffer.from(raw, 'hex');
}
function encrypt(value) {
  if (typeof value !== 'string' || !value.length) {
    throw new Error('SIP password is required');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'),
    data.toString('hex')].join(':');
}
function decrypt(value) {
  if (!value) throw new Error('Encrypted SIP password is missing');
  const [version, ivHex, tagHex, dataHex] = value.split(':');
  if (version !== 'v1' || !ivHex || !tagHex || !dataHex) {
    throw new Error('Unsupported encrypted SIP password format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()
  ]).toString('utf8');
}
module.exports = { encrypt, decrypt };
