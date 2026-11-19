/**
 * Things never stored in long-term memory (v0.10.0): passwords and other credentials, card and bank account numbers,
 * national ID numbers (CNIC and similar) and phone numbers. Used by the assistant's "remember" tool and by
 * Settings → Memory. Returns a short reason for the user, or null when the text is fine.
 *
 * Simple, explainable rules (no model call). They err on the side of refusing: a refused memory can be rephrased
 * without the number; a stored phone or card number can leak into every future conversation.
 */

const CREDENTIAL =
  /\b(?:api[_ -]?keys?|passwords?|passwd|pass ?codes?|pin(?: code)?|otp|cvv|cvc|secret|private key|access token|auth token)\b|github_pat_|\bgsk_\w|\bAIza\w{10}|\bsk-[A-Za-z0-9]{8}|\btvly-\w{8}/i;
const BANK_WORDS = /\b(?:iban|account (?:no|number|#)|a\/c|swift|routing number|sort code)\b/i;
const ID_WORDS = /\b(?:cnic|nic|national id|id card|identity card|passport (?:no|number)|social security|ssn)\b/i;
const PHONE_WORDS = /\b(?:phone|mobile|cell|whats ?app|contact (?:no|number)|telephone|tel)\b/i;

/** Luhn checksum: true for card-number-shaped digit strings. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Runs of digits that may be split by spaces, dashes, dots or brackets ("+92 300-1234567", "4111 1111 1111 1111"). */
function digitRuns(text: string): { raw: string; digits: string }[] {
  return [...text.matchAll(/\+?\(?\d[\d\s().-]{6,}\d/g)].map((m) => ({ raw: m[0].trim(), digits: m[0].replace(/\D/g, "") }));
}

export function sensitiveReason(text: string): string | null {
  if (CREDENTIAL.test(text)) return "it looks like a password, PIN or other secret";
  const runs = digitRuns(text);
  if (runs.some((r) => r.digits.length >= 13 && r.digits.length <= 19 && luhn(r.digits))) return "it looks like a card number";
  if (/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/.test(text) || (BANK_WORDS.test(text) && runs.some((r) => r.digits.length >= 8))) {
    return "it looks like a bank account number";
  }
  if (/\b\d{5}-\d{7}-\d\b/.test(text) || (ID_WORDS.test(text) && runs.some((r) => r.digits.length >= 6))) {
    return "it looks like an ID card number";
  }
  // Phone numbers: 10–15 digits written the way phone numbers start (+, 0 or a bracket), or any 7+ digit number
  // when the text says phone/mobile/WhatsApp. Dates, years and prices don't qualify.
  const phoneShaped = (r: { raw: string; digits: string }) => /^[+0(]/.test(r.raw) && r.digits.length >= 10 && r.digits.length <= 15;
  if (runs.some(phoneShaped) || (PHONE_WORDS.test(text) && runs.some((r) => r.digits.length >= 7))) {
    return "it looks like a phone number";
  }
  return null;
}

/** The full message for the user when a memory is refused. */
export function sensitiveMessage(reason: string): string {
  return (
    `Not saved: ${reason}. Passwords, card or bank numbers, ID card numbers and phone numbers are never kept in ` +
    "memory, so they can't leak into other conversations. You can save the rest without the number."
  );
}
