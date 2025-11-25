const { generateCancelToken } = require('./cancelToken');

function buildCancelUrl({ subscriptionId, customerEmail }) {
  if (!process.env.APP_BASE_URL) {
    throw new Error('APP_BASE_URL is not configured');
  }
  if (!subscriptionId || !customerEmail) {
    throw new Error('subscriptionId and customerEmail are required to build cancel URL');
  }

  const token = generateCancelToken(subscriptionId, customerEmail);
  const url = new URL('/system-cancel.html', process.env.APP_BASE_URL);
  url.searchParams.set('subscription', subscriptionId);
  url.searchParams.set('token', token);
  return url.toString();
}

module.exports = { buildCancelUrl };
