const crypto = require('crypto');

function assertSecret() {
  if (!process.env.CANCEL_TOKEN_SECRET) {
    throw new Error('CANCEL_TOKEN_SECRET is not configured');
  }
  return process.env.CANCEL_TOKEN_SECRET;
}

function buildPayload(subscriptionId, customerEmail) {
  return `${subscriptionId || ''}::${customerEmail || ''}`;
}

function generateCancelToken(subscriptionId, customerEmail) {
  const secret = assertSecret();
  const payload = buildPayload(subscriptionId, customerEmail);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function verifyCancelToken(subscriptionId, customerEmail, token) {
  if (!subscriptionId || !customerEmail || !token) return false;
  const expected = generateCancelToken(subscriptionId, customerEmail);
  const providedBuffer = Buffer.from(token, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

module.exports = {
  generateCancelToken,
  verifyCancelToken
};
