const nodemailer = require('nodemailer');

const DEFAULT_FROM = process.env.EMAIL_FROM || 'no-reply@thebakoagency.com';
const INTERNAL_COPY = process.env.EMAIL_INTERNAL_COPY || 'send@thebakoagency.com';

function resolveCopyList(recipient) {
  if (!INTERNAL_COPY) return undefined;
  if (recipient && INTERNAL_COPY.toLowerCase() === recipient.toLowerCase()) {
    return undefined;
  }
  return INTERNAL_COPY;
}

function assertEmailConfig() {
  const missing = [];
  if (!process.env.SMTP_HOST) missing.push('SMTP_HOST');
  if (!process.env.SMTP_PORT) missing.push('SMTP_PORT');
  if (!process.env.SMTP_USER) missing.push('SMTP_USER');
  if (!process.env.SMTP_PASS) missing.push('SMTP_PASS');
  if (missing.length) {
    throw new Error(`Missing SMTP configuration: ${missing.join(', ')}`);
  }
}

function createTransport() {
  assertEmailConfig();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = port === 465;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

const transporter = createTransport();

async function sendTransactionalEmail(options) {
  const { to, subject, htmlBody, textBody } = options || {};
  if (!to) {
    throw new Error('Recipient email (to) is required');
  }
  if (!subject) {
    throw new Error('Email subject is required');
  }
  if (!htmlBody && !textBody) {
    throw new Error('Either htmlBody or textBody must be provided');
  }

  const mailOptions = {
    from: DEFAULT_FROM,
    to,
    subject,
    html: htmlBody,
    text: textBody,
    bcc: resolveCopyList(to)
  };

  return transporter.sendMail(mailOptions);
}

module.exports = { sendTransactionalEmail };
