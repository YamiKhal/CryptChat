import { Gift } from "lucide-react";

/**
 * The banked-gift counter.
 *
 * Shown always, even at zero -- the parked-credit mechanic is invisible
 * otherwise and someone redeeming a gift while already subscribed needs to know
 * their months went somewhere rather than vanishing. A big number reads as a
 * balance, which is what it is: months waiting to start.
 *
 * The zero state deliberately avoids the phrase "in reserve" -- a redeem hint
 * elsewhere uses it and the two must not read as the same claim.
 */
export default function CreditCounter({
    creditMonths = 0,
}: {
    creditMonths?: number;
}) {
    const has = creditMonths > 0;
    const unit = creditMonths === 1 ? "month" : "months";

    return (
        <div className="border-border bg-surface-raised flex items-center gap-3 rounded-lg border p-3">
            <div
                className={`grid h-10 w-10 flex-none place-items-center rounded-lg ${
                    has ? "bg-info-soft text-info" : "bg-surface text-muted"
                }`}
            >
                <Gift size={18} aria-hidden="true" />
            </div>
            <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                    <span
                        className={`t-h2 font-semibold tabular-nums ${has ? "text-info" : "text-muted"}`}
                    >
                        {creditMonths}
                    </span>
                    <span className="t-base text-muted">
                        gifted {unit} banked
                    </span>
                </div>
                <p className="t-small text-muted">
                    {has
                        ? "Not counting down. They start once nothing else is covering your account. you never pay for time you were given."
                        : "Redeem a gift code while subscribed and the months bank here until your subscription lapses."}
                </p>
            </div>
        </div>
    );
}
