const Stripe = require('stripe');
const { sendTransactionalEmail } = require('../lib/email');
const { buildCancelUrl } = require('../lib/cancelLink');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const DAY_IN_SECONDS = 24 * 60 * 60;

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function formatAmount(amount, currency) {
  const normalizedCurrency = (currency || 'usd').toUpperCase();
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: normalizedCurrency
  }).format((Number(amount) || 0) / 100);
}

function buildOrderConfirmationEmail(session, cancelUrl) {
  const metadata = session.metadata || {};
  const packageId = metadata.packageId || 'custom';
  const locale = metadata.locale || 'en';
  const upfront = formatAmount(session.amount_total, session.currency || 'usd');
  const recurring = formatAmount(metadata.recurringFromMonth2 || 0, session.currency || 'usd');
  const yearly = metadata.yearlyInfraEnabled === 'true' ? formatAmount(metadata.yearlyInfraFee || 0, metadata.yearlyInfraCurrency || session.currency || 'usd') : null;

  const subject = locale === 'es' ? 'Confirmación de tu pedido' : 'Your order is confirmed';
  const nextStepLine =
    locale === 'es'
      ? 'Tu activación ya está en curso. Si necesitas ajustes, respóndenos este correo.'
      : 'Your activation is underway. Reply to this email if you need adjustments.';

  const htmlBody = `
    <div style="font-family: Inter, system-ui, -apple-system, sans-serif; color: #111;">
      <h2 style="margin-bottom: 8px;">${subject}</h2>
      <p style="margin-top: 0;">Package: <strong>${packageId}</strong></p>
      <p style="margin: 12px 0 20px 0;">${nextStepLine}</p>
      <div style="background:#f6f6f8; padding:12px 16px; border-radius:8px;">
        <p style="margin:4px 0;">Today: <strong>${upfront}</strong></p>
        <p style="margin:4px 0;">From month 2: <strong>${recurring}</strong> / month</p>
        ${yearly ? `<p style="margin:4px 0;">Yearly infra (from year 2): <strong>${yearly}</strong> / year</p>` : ''}
      </div>
      ${cancelUrl ? `<p style="margin-top:16px;"><a href="${cancelUrl}" style="color:#111;font-weight:600;">Manage or cancel your subscription</a></p>` : ''}
    </div>
  `;

  return { subject, htmlBody };
}

function buildRenewalReminderEmail(invoice, nextPaymentDate, cancelUrl) {
  const metadata = invoice.metadata || {};
  const packageId = metadata.packageId || 'custom';
  const amount = formatAmount(invoice.amount_due, invoice.currency || invoice.default_currency || 'usd');
  const subject = `Your ${packageId} renewal is coming up`;
  const htmlBody = `
    <div style="font-family: Inter, system-ui, -apple-system, sans-serif; color: #111;">
      <h2 style="margin-bottom: 8px;">Renewal reminder</h2>
      <p style="margin-top: 0;">Your subscription will renew on <strong>${nextPaymentDate.toDateString()}</strong>.</p>
      <p style="margin: 12px 0;">Amount: <strong>${amount}</strong></p>
      <p style="margin: 12px 0 0 0;">If you need changes before renewal, reply to this email.</p>
      ${cancelUrl ? `<p style="margin: 8px 0 0 0;"><a href="${cancelUrl}" style="color:#111;font-weight:600;">Manage or cancel your subscription</a></p>` : ''}
    </div>
  `;
  return { subject, htmlBody };
}

function buildRenewalConfirmationEmail(invoice, cancelUrl) {
  const metadata = invoice.metadata || {};
  const packageId = metadata.packageId || 'custom';
  const amount = formatAmount(invoice.amount_paid || invoice.amount_due, invoice.currency || invoice.default_currency || 'usd');
  const subject = `Payment received for your ${packageId} renewal`;
  const htmlBody = `
    <div style="font-family: Inter, system-ui, -apple-system, sans-serif; color: #111;">
      <h2 style="margin-bottom: 8px;">Renewal payment confirmed</h2>
      <p style="margin-top: 0;">We received your renewal payment.</p>
      <p style="margin: 12px 0;">Amount: <strong>${amount}</strong></p>
      <p style="margin: 12px 0 0 0;">If anything looks off, reply to this email and we will help.</p>
      ${cancelUrl ? `<p style=\"margin: 8px 0 0 0;\"><a href=\"${cancelUrl}\" style=\"color:#111;font-weight:600;\">Manage or cancel your subscription</a></p>` : ''}
    </div>
  `;
  return { subject, htmlBody };
}

function buildCancelLink(subscriptionId, customerEmail) {
  if (!subscriptionId || !customerEmail) return null;
  try {
    return buildCancelUrl({ subscriptionId, customerEmail });
  } catch (err) {
    console.error('Failed to build cancel link', err);
    return null;
  }
}

async function sendOrderConfirmation(session) {
  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) {
    console.warn('[stripe-webhook] No customer email on checkout.session.completed for session', session.id);
    return;
  }
  const cancelUrl = buildCancelLink(session.subscription, customerEmail);
  const { subject, htmlBody } = buildOrderConfirmationEmail(session, cancelUrl);
  await sendTransactionalEmail({ to: customerEmail, subject, htmlBody });
}

async function sendRenewalReminder(invoice) {
  let recipient = invoice.customer_email;
  if (!recipient && invoice.customer) {
    try {
      const customer = await stripe.customers.retrieve(invoice.customer);
      recipient = customer?.email;
    } catch (err) {
      console.error('[stripe-webhook] Failed to retrieve customer for invoice.upcoming', invoice.id, err);
    }
  }
  if (!recipient) {
    console.warn('[stripe-webhook] No customer email for invoice.upcoming', invoice.id);
    return;
  }

  const nextPaymentUnix =
    invoice.next_payment_attempt ||
    invoice.due_date ||
    invoice.lines?.data?.[0]?.period?.end ||
    invoice.period_end;
  if (!nextPaymentUnix) return;

  const secondsUntilRenewal = nextPaymentUnix - Math.floor(Date.now() / 1000);
  if (secondsUntilRenewal > 3 * DAY_IN_SECONDS || secondsUntilRenewal < 0) {
    return;
  }

  const nextPaymentDate = new Date(nextPaymentUnix * 1000);
  const cancelUrl = buildCancelLink(invoice.subscription, recipient);
  const { subject, htmlBody } = buildRenewalReminderEmail(invoice, nextPaymentDate, cancelUrl);
  await sendTransactionalEmail({ to: recipient, subject, htmlBody });
}

async function sendRenewalConfirmation(invoice) {
  let recipient = invoice.customer_email;
  if (!recipient && invoice.customer) {
    try {
      const customer = await stripe.customers.retrieve(invoice.customer);
      recipient = customer?.email;
    } catch (err) {
      console.error('[stripe-webhook] Failed to retrieve customer for invoice.payment_succeeded', invoice.id, err);
    }
  }
  if (!recipient) {
    console.warn('[stripe-webhook] No customer email for invoice.payment_succeeded', invoice.id);
    return;
  }

  const cancelUrl = buildCancelLink(invoice.subscription, recipient);
  const { subject, htmlBody } = buildRenewalConfirmationEmail(invoice, cancelUrl);
  await sendTransactionalEmail({ to: recipient, subject, htmlBody });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method not allowed');
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Stripe is not configured.');
  }

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    const buf = await buffer(req);
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await sendOrderConfirmation(event.data.object);
        break;
      case 'invoice.upcoming':
        await sendRenewalReminder(event.data.object);
        break;
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (invoice.billing_reason === 'subscription_cycle') {
          await sendRenewalConfirmation(invoice);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('Stripe webhook handler failed', err);
    return res.status(500).send('Webhook handler error');
  }

  return res.json({ received: true });
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
