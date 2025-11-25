const Stripe = require('stripe');

const SUCCESS_URL = process.env.SUCCESS_URL || 'https://thebakoagency.com/checkout-success';
const CANCEL_URL = process.env.CANCEL_URL || 'https://thebakoagency.com/checkout-cancel';

const allowedOrigins = ['https://thebakoagency.com', 'https://www.thebakoagency.com'];

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }

  return false;
}

function toCents(value) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) return 0;
  return Math.round(normalized * 100);
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const missingEnv = [];
    if (!process.env.STRIPE_SECRET_KEY) missingEnv.push('STRIPE_SECRET_KEY');
    if (!process.env.APP_BASE_URL) missingEnv.push('APP_BASE_URL');

    if (missingEnv.length) {
      console.error('[checkout-session] Missing env vars:', missingEnv.join(', '));
      return res.status(500).json({
        error: 'MISSING_ENV',
        message: `Missing required environment variable: ${missingEnv.join(', ')}`
      });
    }

    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const body = req.body || {};
    const {
      packageId = 'custom',
      addons = [],
      totals = {},
      financing = {},
      currency = 'usd',
      locale = 'es',
      metaBudgetMonthly = 0,
      planProtection = {},
      keepSystemOn = {},
      yearlyInfra = {},
      discount = {}
    } = body;

    const payloadErrors = [];
    if (!packageId || typeof packageId !== 'string') payloadErrors.push('packageId');
    if (!totals || typeof totals !== 'object') {
      payloadErrors.push('totals');
    } else {
      const numericTotals = ['firstMonthBase', 'originalFirstMonthBase', 'firstMonthWithFinancing', 'monthlyFromMonth2'];
      numericTotals.forEach((key) => {
        if (totals[key] != null && Number.isNaN(Number(totals[key]))) {
          payloadErrors.push(`totals.${key}`);
        }
      });
    }
    if (!Array.isArray(addons)) payloadErrors.push('addons');
    if (currency && typeof currency !== 'string') payloadErrors.push('currency');
    if (locale && typeof locale !== 'string') payloadErrors.push('locale');
    if (metaBudgetMonthly != null && Number.isNaN(Number(metaBudgetMonthly))) {
      payloadErrors.push('metaBudgetMonthly');
    }

    if (payloadErrors.length) {
      return res.status(400).json({
        error: 'INVALID_PAYLOAD',
        message: `Missing or invalid fields: ${payloadErrors.join(', ')}`
      });
    }

    const firstMonthBase = Number(totals.firstMonthBase || 0);
    const originalFirstMonthBase = Number(totals.originalFirstMonthBase ?? firstMonthBase);
    const firstMonthWithFinancing = Number(totals.firstMonthWithFinancing || firstMonthBase);
    const recurringFromMonth2 = Number(totals.monthlyFromMonth2 || 0);

    const financingSelected = Boolean(financing && financing.selected);
    const financingFee = Number(financing && financing.financingFee ? financing.financingFee : 0);

    const yearlyInfraFee = Number(yearlyInfra.yearlyInfraFee || yearlyInfra.fee || 0);
    const yearlyInfraEnabled = yearlyInfra.enabled !== false && yearlyInfraFee > 0;
    const yearlyInfraAmountCents = toCents(yearlyInfraFee);

    const discountType = typeof discount.type === 'string' ? discount.type : 'none';
    const discountValue = Number(discount.value ?? 0);
    const discountedUpfrontTotal = Number(
      discount.discountedUpfrontTotal != null ? discount.discountedUpfrontTotal : firstMonthBase
    );
    const originalUpfrontTotal = Number(
      discount.originalUpfrontTotal != null ? discount.originalUpfrontTotal : originalFirstMonthBase
    );
    const discountAmountApplied = Math.max(originalUpfrontTotal - discountedUpfrontTotal, 0);

    const discountMetadata = {
      discountType,
      discountValue: discountValue.toString(),
      originalUpfrontTotal: originalUpfrontTotal.toString(),
      discountedUpfrontTotal: discountedUpfrontTotal.toString(),
      discountAmount: discountAmountApplied.toString()
    };

    const planProtectionMetadata = {};
    if (planProtection && planProtection.selected) {
      planProtectionMetadata.hasPlanProtection = 'true';
      planProtectionMetadata.protectionFee = (planProtection.protectionFee ?? 50).toString();
      if (planProtection.monthlyRegular != null) {
        planProtectionMetadata.monthlyRegular = planProtection.monthlyRegular.toString();
      }
      if (planProtection.monthlyMinimum != null) {
        planProtectionMetadata.monthlyMinimum = planProtection.monthlyMinimum.toString();
      }
    }

    const keepSystemMetadata = {};
    if (keepSystemOn && keepSystemOn.selected) {
      keepSystemMetadata.keepSystemOnOnly = 'true';
      keepSystemMetadata.keepSystemOnFee = (keepSystemOn.keepSystemOnFee ?? 0).toString();
      if (keepSystemOn.monthlyRegular != null) {
        keepSystemMetadata.monthlyRegular = keepSystemOn.monthlyRegular.toString();
      }
      if (keepSystemOn.monthlyMinimum != null) {
        keepSystemMetadata.monthlyMinimum = keepSystemOn.monthlyMinimum.toString();
      }
      keepSystemMetadata.monthlyFeeForMarketing = '0';
      keepSystemMetadata.monthlyFeeKeepSystemOn = (keepSystemOn.monthlyFeeKeepSystemOn ?? 0).toString();
    } else {
      keepSystemMetadata.keepSystemOnOnly = 'false';
      if (keepSystemOn && keepSystemOn.monthlyRegular != null) {
        keepSystemMetadata.monthlyRegular = keepSystemOn.monthlyRegular.toString();
      }
      if (keepSystemOn && keepSystemOn.monthlyMinimum != null) {
        keepSystemMetadata.monthlyMinimum = keepSystemOn.monthlyMinimum.toString();
      }
      if (keepSystemOn && keepSystemOn.monthlyFeeForMarketing != null) {
        keepSystemMetadata.monthlyFeeForMarketing = keepSystemOn.monthlyFeeForMarketing.toString();
      }
    }

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
      // IMPORTANT: Stripe Checkout does not allow multiple recurring intervals in one session.
      // We only create the monthly subscription; yearly infra intent is captured via metadata.
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
          recurringFromMonth2: recurringFromMonth2.toString(),
          yearlyInfraEnabled: yearlyInfraEnabled ? 'true' : 'false',
          yearlyInfraFee: yearlyInfraFee.toString(),
          yearlyInfraAmountCents: yearlyInfraAmountCents.toString(),
          yearlyTrialDays: '365',
          ...planProtectionMetadata,
          ...keepSystemMetadata,
          ...discountMetadata
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
        recurringFromMonth2: recurringFromMonth2.toString(),
        yearlyInfraEnabled: yearlyInfraEnabled ? 'true' : 'false',
        yearlyInfraFee: yearlyInfraFee.toString(),
        yearlyInfraAmountCents: yearlyInfraAmountCents.toString(),
        ...planProtectionMetadata,
        ...keepSystemMetadata,
        ...discountMetadata
      },
      success_url: `${SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${CANCEL_URL}?canceled=true`
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('[checkout-session] Error creating Stripe session:', error);
    return res.status(500).json({
      error: 'CHECKOUT_SESSION_FAILED',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message
    });
  }
};
