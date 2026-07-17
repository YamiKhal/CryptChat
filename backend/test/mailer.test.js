import test from 'node:test';
import assert from 'node:assert/strict';
import { redactAddresses } from '../src/lib/mailer.js';

/**
 * Provider errors get logged. Addresses must not.
 *
 * The balance this strikes: the *domain* is what identifies a misconfiguration
 * (unverified sending domain, wrong API key scope), so it stays. The local part
 * is what identifies a person, so it goes. Dropping the whole message instead --
 * which is what this code used to do -- turns a self-explanatory 403 into an
 * unactionable status code and sends the operator to the provider's dashboard to
 * learn what their own logs should have said.
 */

test('redacts the local part of an address', () => {
  assert.equal(redactAddresses('sent to alice@example.com ok'), 'sent to •••@example.com ok');
});

test('keeps the domain -- it is the whole diagnostic', () => {
  const real = 'The yourdomain.example domain is not verified.';
  // No address at all here; nothing should change.
  assert.equal(redactAddresses(real), real);
});

test('redacts a real Resend 403 while keeping what explains it', () => {
  const body =
    'You can only send testing emails to your own email address (owner@gmail.com). ' +
    'To send emails to other recipients, please verify a domain at resend.com/domains, ' +
    'and change the `from` address to an email using this domain.';

  const out = redactAddresses(body);

  assert.ok(!out.includes('owner@gmail.com'));
  assert.ok(!out.includes('owner'));
  // Still says what went wrong and where.
  assert.ok(out.includes('gmail.com'));
  assert.ok(out.includes('verify a domain'));
});

test('redacts several addresses in one message', () => {
  const out = redactAddresses('from a@x.com to b@y.com');
  assert.equal(out, 'from •••@x.com to •••@y.com');
});

test('redacts an address inside angle brackets', () => {
  // MAIL_FROM's shape: "Name <addr@domain>".
  const out = redactAddresses('from: CryptChat <noreply@example.com>');
  assert.ok(!out.includes('noreply'));
  assert.ok(out.includes('example.com'));
});

test('redacts plus-tagged and dotted addresses', () => {
  const out = redactAddresses('first.last+tag@example.com failed');
  assert.ok(!out.includes('first.last'));
  assert.ok(!out.includes('+tag'));
  assert.ok(out.includes('•••@example.com'));
});

test('leaves messages with no address untouched', () => {
  const msg = 'rate limited, try again later';
  assert.equal(redactAddresses(msg), msg);
});

test('does not throw on non-string input', () => {
  // Provider bodies are not always what the docs claim.
  assert.doesNotThrow(() => redactAddresses(undefined));
  assert.doesNotThrow(() => redactAddresses(null));
  assert.doesNotThrow(() => redactAddresses(42));
});
