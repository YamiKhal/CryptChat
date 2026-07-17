import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import Composer from './Composer';
import { DEFAULT_LIMITS, Limits } from '../lib/limits';

const free: Limits = { ...DEFAULT_LIMITS, canUpload: true, maxChars: 1000 };
const premium: Limits = {
  ...DEFAULT_LIMITS,
  canUpload: true,
  premium: true,
  tier: 'premium',
  maxChars: 4000,
};

/**
 * Controlled wrapper -- the real Composer is driven by Chat's state.
 *
 * `value`/`onChange` are pulled out of the incoming props rather than spread:
 * the harness owns them, and letting a caller pass them through would silently
 * uncontrol the textarea.
 */
function Harness({
  value: initial,
  onChange: _ignored,
  ...props
}: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const [value, setValue] = useState(initial ?? '');
  return (
    <Composer
      onSend={vi.fn()}
      onAttach={vi.fn()}
      limits={free}
      placeholder="message"
      {...props}
      value={value}
      onChange={setValue}
      canSend={value.trim().length > 0}
    />
  );
}

describe('Composer', () => {
  it('sends on Enter', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    await user.type(screen.getByPlaceholderText('message'), 'hello{Enter}');
    expect(onSend).toHaveBeenCalledOnce();
  });

  it('inserts a newline on Shift+Enter instead of sending', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    const box = screen.getByPlaceholderText('message');
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');

    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('line one\nline two');
  });

  it('does not send an empty message', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    await user.type(screen.getByPlaceholderText('message'), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send whitespace only', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    await user.type(screen.getByPlaceholderText('message'), '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('grows with content instead of scrolling horizontally', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByPlaceholderText('message') as HTMLTextAreaElement;

    const before = parseInt(box.style.height || '0', 10);
    await user.type(box, 'a'.repeat(200));
    const after = parseInt(box.style.height, 10);

    expect(after).toBeGreaterThan(before);
  });

  it('stops growing at the ceiling and scrolls internally instead', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByPlaceholderText('message') as HTMLTextAreaElement;

    // paste, not type: userEvent.type fires a full event cycle per character,
    // and 2000 of them takes half a minute for no added coverage.
    await user.click(box);
    await user.paste('a'.repeat(2000));

    // 140px ceiling. Past it the box must scroll, not keep growing off-screen.
    expect(parseInt(box.style.height, 10)).toBeLessThanOrEqual(140);
    expect(box.style.overflowY).toBe('auto');
  });

  it('shrinks again when text is deleted', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const box = screen.getByPlaceholderText('message') as HTMLTextAreaElement;

    await user.click(box);
    await user.paste('a'.repeat(300));
    const tall = parseInt(box.style.height, 10);

    await user.clear(box);
    const short = parseInt(box.style.height, 10);

    // Regression: reading scrollHeight without resetting height to 'auto' first
    // makes the box grow-only, because scrollHeight never reports less than the
    // current height.
    expect(short).toBeLessThan(tall);
  });

  it('hides the counter until the message gets long', () => {
    // A permanent "0 / 1,000" turns a chat box into a form field.
    render(<Harness value="short" />);
    expect(screen.queryByTestId('char-count')).not.toBeInTheDocument();
  });

  it('shows the counter as the limit approaches', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByPlaceholderText('message'));
    await user.paste('x'.repeat(900));

    // Built with toLocaleString rather than hardcoded: the component formats for
    // the user's locale, and the runner's is not guaranteed to group with commas.
    expect(screen.getByTestId('char-count')).toHaveTextContent(
      `${(900).toLocaleString()} / ${(1000).toLocaleString()}`
    );
  });

  it('blocks sending past the character limit', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);

    await user.click(screen.getByPlaceholderText('message'));
    await user.paste('x'.repeat(1001));
    await user.keyboard('{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('lets a premium user past the free limit', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} limits={premium} />);

    await user.click(screen.getByPlaceholderText('message'));
    await user.paste('x'.repeat(2000));
    await user.keyboard('{Enter}');

    expect(onSend).toHaveBeenCalledOnce();
  });

  it('mentions the supporter tier when a free user goes over', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByPlaceholderText('message'));
    await user.paste('x'.repeat(1001));

    expect(screen.getByText(/supporters get/i)).toBeInTheDocument();
  });

  it('does not upsell a premium user who goes over their own limit', async () => {
    const user = userEvent.setup();
    render(<Harness limits={premium} />);
    await user.click(screen.getByPlaceholderText('message'));
    await user.paste('x'.repeat(4001));

    expect(screen.queryByText(/supporters get/i)).not.toBeInTheDocument();
  });

  it('counts emoji as one character each', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByPlaceholderText('message'));
    await user.paste('👍'.repeat(900));

    // 900, not 1800 -- which is what .length would have said, since each emoji
    // is a surrogate pair.
    expect(screen.getByTestId('char-count')).toHaveTextContent(
      `${(900).toLocaleString()} / ${(1000).toLocaleString()}`
    );
  });

  it('disables attach when the account cannot upload, and says why', () => {
    render(
      <Harness
        limits={{
          ...DEFAULT_LIMITS,
          canUpload: false,
          uploadDenialReason: 'Confirm your email address to send files.',
        }}
      />
    );

    const attach = screen.getByLabelText('Attach a file');
    expect(attach).toBeDisabled();
    // A greyed button with no reason is a dead end.
    expect(attach).toHaveAttribute('title', expect.stringMatching(/confirm your email/i));
  });

  it('advertises the tier file cap when uploads are allowed', () => {
    render(<Harness limits={{ ...free, maxFileBytes: 20 * 1024 * 1024 }} />);
    expect(screen.getByLabelText('Attach a file')).toHaveAttribute(
      'title',
      expect.stringMatching(/20MB/)
    );
  });

  it('disables everything while the channel has no key', () => {
    render(<Harness disabled />);
    expect(screen.getByPlaceholderText('message')).toBeDisabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
  });

  it('opens the emoji picker and inserts at the caret', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const box = screen.getByPlaceholderText('message') as HTMLTextAreaElement;
    await user.type(box, 'ab');
    // Put the caret between a and b.
    box.setSelectionRange(1, 1);

    await user.click(screen.getByLabelText('Insert emoji'));
    // From the default (Smileys) group -- the picker opens on the first group,
    // so a gesture emoji would not be on screen yet.
    await user.click(screen.getByRole('button', { name: '😀' }));

    // Appending would be wrong whenever the user clicked back into the middle.
    expect(box.value).toBe('a😀b');
  });

  it('finds an emoji from another group by search', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByLabelText('Insert emoji'));
    await user.type(screen.getByPlaceholderText('search'), 'thumbs');
    await user.click(screen.getByRole('button', { name: '👍' }));

    expect(screen.getByPlaceholderText('message')).toHaveValue('👍');
  });

  it('closes the emoji picker on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByLabelText('Insert emoji'));
    expect(screen.getByPlaceholderText('search')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText('search')).not.toBeInTheDocument();
  });
});
