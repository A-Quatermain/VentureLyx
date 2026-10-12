/**
 * Venturelyx :: transactional email templates.
 *
 * Plain inline-styled HTML, not React Email — one more dependency for six
 * fairly simple templates wasn't worth it, and table-based inline-style
 * HTML is the one format every mail client reliably renders. Every
 * template returns {subject, html, text} — text is a real plain-text
 * alternative, not html-stripped, since every one of these is a security-
 * or money-relevant email where a client rendering only plain text (some
 * corporate filters do) must still be fully usable.
 */
interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND_COLOR = '#4F46E5';

function layout(bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;">
      <tr><td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;">
          <tr><td style="padding:28px 32px 0 32px;">
            <span style="font-size:20px;font-weight:700;color:${BRAND_COLOR};letter-spacing:-0.01em;">Venturelyx</span>
          </td></tr>
          <tr><td style="padding:24px 32px 32px 32px;color:#1f2937;font-size:15px;line-height:1.6;">
            ${bodyHtml}
          </td></tr>
        </table>
        <p style="color:#9ca3af;font-size:12px;margin-top:20px;">Venturelyx &middot; https://venturelyx.com</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function button(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 24px;border-radius:8px;margin:16px 0;">${label}</a>`;
}

export function passwordResetEmail(resetUrl: string): RenderedEmail {
  return {
    subject: 'Reset your Venturelyx password',
    html: layout(`
      <p>We received a request to reset your Venturelyx password.</p>
      ${button('Reset password', resetUrl)}
      <p style="color:#6b7280;font-size:13px;">This link expires in 30 minutes and can only be used once. If you didn't request this, you can ignore this email — your password hasn't been changed.</p>
    `),
    text: `We received a request to reset your Venturelyx password.\n\n${resetUrl}\n\nThis link expires in 30 minutes and can only be used once. If you didn't request this, you can ignore this email.`,
  };
}

export function emailVerificationEmail(verifyUrl: string): RenderedEmail {
  return {
    subject: 'Verify your Venturelyx email address',
    html: layout(`
      <p>One more step — confirm this is your email address.</p>
      ${button('Verify email', verifyUrl)}
      <p style="color:#6b7280;font-size:13px;">This link expires in 24 hours.</p>
    `),
    text: `Confirm your email address:\n\n${verifyUrl}\n\nThis link expires in 24 hours.`,
  };
}

export function orgInviteEmail(orgName: string, inviterName: string, acceptUrl: string): RenderedEmail {
  return {
    subject: `${inviterName} invited you to ${orgName} on Venturelyx`,
    html: layout(`
      <p><strong>${inviterName}</strong> invited you to join <strong>${orgName}</strong> on Venturelyx.</p>
      ${button('Accept invite', acceptUrl)}
      <p style="color:#6b7280;font-size:13px;">This link expires in 7 days.</p>
    `),
    text: `${inviterName} invited you to join ${orgName} on Venturelyx.\n\n${acceptUrl}\n\nThis link expires in 7 days.`,
  };
}

export function billingReceiptEmail(orgName: string, amount: string, planLabel: string): RenderedEmail {
  return {
    subject: 'Your Venturelyx payment receipt',
    html: layout(`
      <p>This confirms a successful payment for <strong>${orgName}</strong>.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
        <tr><td style="padding:10px 0;color:#6b7280;">Plan</td><td style="padding:10px 0;text-align:right;">${planLabel}</td></tr>
        <tr><td style="padding:10px 0;color:#6b7280;">Amount</td><td style="padding:10px 0;text-align:right;font-weight:600;">${amount}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:13px;">Manage your subscription anytime from Settings &rarr; Billing.</p>
    `),
    text: `Payment received for ${orgName}.\n\nPlan: ${planLabel}\nAmount: ${amount}\n\nManage your subscription from Settings -> Billing.`,
  };
}

export function billingPaymentFailedEmail(orgName: string, manageUrl: string): RenderedEmail {
  return {
    subject: 'Action needed: your Venturelyx payment failed',
    html: layout(`
      <p>We couldn't process the most recent payment for <strong>${orgName}</strong>.</p>
      <p>Your modules are still active for now, but please update your payment method soon to avoid an interruption.</p>
      ${button('Update payment method', manageUrl)}
    `),
    text: `We couldn't process the most recent payment for ${orgName}.\n\nYour modules are still active for now, but please update your payment method soon to avoid an interruption.\n\n${manageUrl}`,
  };
}

export function growthScanReportEmail(reportUrl: string, healthScore: number | null): RenderedEmail {
  const scoreLine = healthScore !== null ? `Your site's health score: <strong>${healthScore}/100</strong>.` : `Your scan is finishing up — the full report will be ready shortly.`;
  return {
    subject: 'Your free Venturelyx Growth Scan is ready',
    html: layout(`
      <p>Here's your Growth Scan report.</p>
      <p>${scoreLine}</p>
      ${button('View your full report', reportUrl)}
      <p style="color:#6b7280;font-size:13px;">No obligation — this is yours to keep either way.</p>
    `),
    text: `Here's your Growth Scan report.\n\n${scoreLine.replace(/<[^>]+>/g, '')}\n\n${reportUrl}`,
  };
}

export function paymentLinkEmail(orgName: string, planLabel: string, checkoutUrl: string): RenderedEmail {
  return {
    subject: `Complete your Venturelyx ${planLabel} setup`,
    html: layout(`
      <p>You're one step from getting started with Venturelyx ${planLabel.toLowerCase()} for <strong>${orgName}</strong>.</p>
      ${button('Continue to secure payment', checkoutUrl)}
      <p style="color:#6b7280;font-size:13px;">This link is unique to you — please don't share it. If you weren't expecting this, you can ignore it.</p>
    `),
    text: `You're one step from getting started with Venturelyx ${planLabel.toLowerCase()} for ${orgName}.\n\n${checkoutUrl}`,
  };
}

export function onboardingWelcomeEmail(orgName: string, setPasswordUrl: string): RenderedEmail {
  return {
    subject: `Welcome to Venturelyx — let's get ${orgName} set up`,
    html: layout(`
      <p>Payment confirmed — welcome to Venturelyx!</p>
      <p>Set your password to access your onboarding checklist for <strong>${orgName}</strong>.</p>
      ${button('Set your password', setPasswordUrl)}
      <p style="color:#6b7280;font-size:13px;">This link expires in 7 days.</p>
    `),
    text: `Payment confirmed — welcome to Venturelyx!\n\nSet your password to access your onboarding checklist for ${orgName}:\n\n${setPasswordUrl}\n\nThis link expires in 7 days.`,
  };
}

export function waitlistConfirmationEmail(businessName: string | null): RenderedEmail {
  return {
    subject: "You're on the Venturelyx waitlist",
    html: layout(`
      <p>Thanks for your interest in Venturelyx${businessName ? ` for <strong>${businessName}</strong>` : ''}.</p>
      <p>We'll reach out as soon as a spot opens up.</p>
    `),
    text: `Thanks for your interest in Venturelyx${businessName ? ` for ${businessName}` : ''}.\n\nWe'll reach out as soon as a spot opens up.`,
  };
}
