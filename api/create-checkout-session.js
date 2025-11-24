const Stripe = require('stripe');

const SUCCESS_URL = process.env.SUCCESS_URL || 'https://thebakoagency.com/checkout-success';
const CANCEL_URL = process.env.CANCEL_URL || 'https://thebakoagency.com/checkout-cancel';

function toCents(value) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) return 0;
  return Math.round(normalized * 100);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Stripe secret key is not configured.' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  const {
    packageId = 'custom',
    addons = [],
    totals = {},
    financing = {},
    currency = 'usd',
    locale = 'es',
    metaBudgetMonthly = 0
  } = req.body || {};

  try {
    const firstMonthBase = Number(totals.firstMonthBase || 0);
    const firstMonthWithFinancing = Number(totals.firstMonthWithFinancing || firstMonthBase);
    const recurringFromMonth2 = Number(totals.monthlyFromMonth2 || 0);

    const financingSelected = Boolean(financing && financing.selected);
    const financingFee = Number(financing && financing.financingFee ? financing.financingFee : 0);

    // First payment = setup (which already includes month 1) + Meta budget for month 1
    // Financing applies only to this upfront charge.
    const firstPaymentAmount = financingSelected ? firstMonthWithFinancing : firstMonthBase;

    const lineItems = [
      {
        // One-time setup that already bundles month 1 + Meta budget (if provided)
        price_data: {
          currency,
          product_data: {
            name: `Setup + Month 1 (${packageId})`,
            metadata: { packageId, locale }
          },
          unit_amount: toCents(firstPaymentAmount),
          tax_behavior: 'exclusive'
        },
        quantity: 1
      },
      {
        // Recurring charge starts in month 2 after the trial window
        price_data: {
          currency,
          product_data: {
            name: `Monthly from month 2 (${packageId})`,
            metadata: { packageId, locale }
          },
          recurring: { interval: 'month' },
          unit_amount: toCents(recurringFromMonth2),
          tax_behavior: 'exclusive'
        },
        quantity: 1
      }
    ];

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      allow_promotion_codes: true, // Enable manual coupon entry in Checkout
      payment_method_types: ['card'],
      line_items: lineItems,
      subscription_data: {
        // Ensure recurring billing starts on month 2
        trial_period_days: 30,
        metadata: {
          packageId,
          locale,
          financingSelected: financingSelected ? 'true' : 'false',
          financingFee: financingFee.toString(),
          metaBudgetMonthly: metaBudgetMonthly.toString(),
          firstPaymentAmount: firstPaymentAmount.toString(),
          recurringFromMonth2: recurringFromMonth2.toString()
        }
      },
      metadata: {
        packageId,
        locale,
        financingSelected: financingSelected ? 'true' : 'false',
        financingFee: financingFee.toString(),
        metaBudgetMonthly: metaBudgetMonthly.toString(),
        addons: JSON.stringify(addons || []),
        firstPaymentAmount: firstPaymentAmount.toString(),
        recurringFromMonth2: recurringFromMonth2.toString()
      },
      success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CANCEL_URL}?canceled=true`
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Stripe checkout session error', error);
    return res.status(500).json({ error: error.message });
  }
};
