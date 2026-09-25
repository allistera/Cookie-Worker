// Address and header-value checks shared by every path that hands an address
// or subject to the mail provider: /send (cookie-web-send) and the mailto
// unsubscribe (cookie-web-messages), whose target is sender-controlled.

// Pragmatic RFC 5322 subset: one @, no whitespace or control characters, no
// header-significant punctuation (so no comma-separated lists), and a dotted
// domain. Resend would reject malformed values anyway, but rejecting here
// keeps CRLF/control-character payloads (classic SMTP header-injection
// shapes) out of the provider payload and anything stored alongside it.
const ADDRESS_RE =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** @param {string} value */
export function hasControlChars(value) {
  for (const character of value) {
    const code = /** @type {number} */ (character.codePointAt(0));
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** @param {string} address Exactly one address — a list never matches. */
export function isValidEmailAddress(address) {
  return address.length <= 320 && ADDRESS_RE.test(address);
}
