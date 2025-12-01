const Stripe = require('stripe');
const { verifyCancelToken } = require('../lib/cancelToken');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const cancelTokenSecret = process.env.CANCEL_TOKEN_SECRET;

function jsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

async function fetchSubscriptionWithCustomer(stripeClient, subscriptionId) {
  return stripeClient.subscriptions.retrieve(subscriptionId, { expand: ['customer'] });
}

function formatSubscriptionResponse(subscription) {
  const metadata = subscription.metadata || {};
  return {
    subscriptionId: subscription.id,
    packageId: metadata.packageId || 'custom',
    status: subscription.status,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    currentPeriodEnd: subscription.current_period_end
  };
}

module.exports = async function handler(req, res) {
  if (!stripeSecretKey || !cancelTokenSecret) {
    return jsonError(res, 500, 'Stripe or cancellation secret not configured.');
  }

  const stripe = Stripe(stripeSecretKey);

  if (req.method === 'GET') {
    const subscriptionId = req.query.subscription;
    const token = req.query.token;

    if (!subscriptionId || !token) {
      return jsonError(res, 400, 'Missing subscription or token');
    }

    try {
      const subscription = await fetchSubscriptionWithCustomer(stripe, subscriptionId);
      const customerEmail = subscription.customer?.email;
      if (!verifyCancelToken(subscriptionId, customerEmail, token)) {
        return jsonError(res, 401, 'Invalid or expired link');
      }

      return res.status(200).json(formatSubscriptionResponse(subscription));
    } catch (error) {
      console.error('Error fetching subscription for cancellation', error);
      return jsonError(res, 500, 'Unable to fetch subscription');
    }
  }

  if (req.method === 'POST') {
    const { subscriptionId, token } = req.body || {};

    if (!subscriptionId || !token) {
      return jsonError(res, 400, 'Missing subscription or token');
    }

    try {
      const subscription = await fetchSubscriptionWithCustomer(stripe, subscriptionId);
      const customerEmail = subscription.customer?.email;
      if (!verifyCancelToken(subscriptionId, customerEmail, token)) {
        return jsonError(res, 401, 'Invalid or expired link');
      }

      if (subscription.cancel_at_period_end || subscription.status === 'canceled') {
        return res.status(200).json({
          status: subscription.cancel_at_period_end ? 'scheduled' : 'cancelled',
          effectiveDate: subscription.current_period_end
        });
      }

      const updated = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
      });

      return res.status(200).json({
        status: updated.cancel_at_period_end ? 'scheduled' : 'cancelled',
        effectiveDate: updated.current_period_end
      });
    } catch (error) {
      console.error('Error cancelling subscription', error);
      return jsonError(res, 500, error.message || 'Unable to cancel subscription');
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return jsonError(res, 405, 'Method not allowed');
};
