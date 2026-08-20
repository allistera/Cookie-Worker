// Calls Resend's HTTP API directly rather than depending on the `resend`
// npm package: its Workers/edge-runtime compatibility isn't documented, and
// this is the entire surface Cookie-Web's api/messages.js actually used
// (resend.emails.send with a plain text body) — a single fetch() call.

/**
 * @param {{apiKey: string, from: string, to: string[], subject: string, text: string}} options
 */
export async function sendEmail({ apiKey, from, to, subject, text }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!response.ok) {
    const body = /** @type {{message?: string}} */ (await response.json().catch(() => ({})));
    throw new Error(body?.message || 'Resend send failed');
  }
}
