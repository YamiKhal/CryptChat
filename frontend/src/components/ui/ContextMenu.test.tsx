import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
    ContextMenu,
    useContextMenu,
    MenuItem,
} from "@/components/ui/ContextMenu";

/**
 * The context menu, on both input methods.
 *
 * The touch path is the one worth testing hard: it is built on timers and
 * movement tolerance and a regression there makes the transcript unusable on
 * mobile (a menu opening mid-scroll) rather than merely missing a feature.
 */

const items: MenuItem[] = [
    { label: "Reply", onSelect: vi.fn() },
    { label: "React", onSelect: vi.fn() },
];

function Target({ onOpen }: { onOpen?: () => void }) {
    const { handlers, position, close } = useContextMenu();
    return (
        <div>
            <div data-testid="target" {...handlers}>
                a message
            </div>
            {position && (
                <>
                    {onOpen?.()}
                    <ContextMenu
                        items={items}
                        position={position}
                        onClose={close}
                    />
                </>
            )}
        </div>
    );
}

describe("ContextMenu", () => {
    it("opens on right-click", async () => {
        const user = userEvent.setup();
        render(<Target />);

        await user.pointer({
            keys: "[MouseRight]",
            target: screen.getByTestId("target"),
        });
        expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("does not open on left-click", async () => {
        const user = userEvent.setup();
        render(<Target />);

        await user.click(screen.getByTestId("target"));
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("runs the chosen action and closes", async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();

        function One() {
            const { handlers, position, close } = useContextMenu();
            return (
                <div>
                    <div data-testid="target" {...handlers}>
                        m
                    </div>
                    {position && (
                        <ContextMenu
                            items={[{ label: "Reply", onSelect }]}
                            position={position}
                            onClose={close}
                        />
                    )}
                </div>
            );
        }

        render(<One />);
        await user.pointer({
            keys: "[MouseRight]",
            target: screen.getByTestId("target"),
        });
        await user.click(screen.getByRole("menuitem", { name: "Reply" }));

        expect(onSelect).toHaveBeenCalledOnce();
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("closes on Escape", async () => {
        const user = userEvent.setup();
        render(<Target />);

        await user.pointer({
            keys: "[MouseRight]",
            target: screen.getByTestId("target"),
        });
        await user.keyboard("{Escape}");

        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("closes on a click outside", async () => {
        const user = userEvent.setup();
        render(
            <div>
                <Target />
                <button>elsewhere</button>
            </div>,
        );

        await user.pointer({
            keys: "[MouseRight]",
            target: screen.getByTestId("target"),
        });
        await user.click(screen.getByRole("button", { name: "elsewhere" }));

        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });

    it("does not close when clicking inside itself", async () => {
        const user = userEvent.setup();
        render(<Target />);

        await user.pointer({
            keys: "[MouseRight]",
            target: screen.getByTestId("target"),
        });
        // Clicking the menu's own padding must not dismiss it before the user
        // reaches an item.
        await user.click(screen.getByRole("menu"));

        expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("does not fire a disabled item", async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();

        function One() {
            const { handlers, position, close } = useContextMenu();
            return (
                <div>
                    <div data-testid="target" {...handlers}>
                        m
                    </div>
                    {position && (
                        <ContextMenu
                            items={[
                                {
                                    label: "Nope",
                                    onSelect,
                                    disabled: true,
                                    hint: "why not",
                                },
                            ]}
                            position={position}
                            onClose={close}
                        />
                    )}
                </div>
            );
        }

        render(<One />);
        await user.pointer({
            keys: "[MouseRight]",
            target: screen.getByTestId("target"),
        });

        const item = screen.getByRole("menuitem", { name: "Nope" });
        expect(item).toBeDisabled();
        // A greyed row with no reason is a dead end.
        expect(item).toHaveAttribute("title", "why not");

        await user.click(item).catch(() => {});
        expect(onSelect).not.toHaveBeenCalled();
    });

    describe("touch long-press", () => {
        it("opens after holding", async () => {
            vi.useFakeTimers();
            try {
                render(<Target />);
                const target = screen.getByTestId("target");

                act(() => {
                    target.dispatchEvent(
                        new PointerEvent("pointerdown", {
                            bubbles: true,
                            clientX: 10,
                            clientY: 10,
                            pointerType: "touch",
                        }),
                    );
                });

                // Not yet -- a tap must not open it.
                expect(screen.queryByRole("menu")).not.toBeInTheDocument();

                act(() => {
                    vi.advanceTimersByTime(500);
                });

                expect(screen.getByRole("menu")).toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
        });

        it("does not open on a quick tap", async () => {
            vi.useFakeTimers();
            try {
                render(<Target />);
                const target = screen.getByTestId("target");

                act(() => {
                    target.dispatchEvent(
                        new PointerEvent("pointerdown", {
                            bubbles: true,
                            clientX: 10,
                            clientY: 10,
                            pointerType: "touch",
                        }),
                    );
                    vi.advanceTimersByTime(100);
                    target.dispatchEvent(
                        new PointerEvent("pointerup", {
                            bubbles: true,
                            pointerType: "touch",
                        }),
                    );
                    vi.advanceTimersByTime(1000);
                });

                expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
        });

        it("cancels when the finger moves -- that is a scroll, not a hold", async () => {
            vi.useFakeTimers();
            try {
                render(<Target />);
                const target = screen.getByTestId("target");

                act(() => {
                    target.dispatchEvent(
                        new PointerEvent("pointerdown", {
                            bubbles: true,
                            clientX: 10,
                            clientY: 10,
                            pointerType: "touch",
                        }),
                    );
                    // Past the 10px tolerance: the user is scrolling the transcript.
                    target.dispatchEvent(
                        new PointerEvent("pointermove", {
                            bubbles: true,
                            clientX: 10,
                            clientY: 60,
                            pointerType: "touch",
                        }),
                    );
                    vi.advanceTimersByTime(1000);
                });

                expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
        });

        it("tolerates a tiny wobble and still opens", async () => {
            vi.useFakeTimers();
            try {
                render(<Target />);
                const target = screen.getByTestId("target");

                act(() => {
                    target.dispatchEvent(
                        new PointerEvent("pointerdown", {
                            bubbles: true,
                            clientX: 10,
                            clientY: 10,
                            pointerType: "touch",
                        }),
                    );
                    // 3px: a finger resting on glass is never perfectly still.
                    target.dispatchEvent(
                        new PointerEvent("pointermove", {
                            bubbles: true,
                            clientX: 12,
                            clientY: 13,
                            pointerType: "touch",
                        }),
                    );
                    vi.advanceTimersByTime(500);
                });

                expect(screen.getByRole("menu")).toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
        });

        it("ignores a mouse pointerdown, so right-click is not double-handled", async () => {
            vi.useFakeTimers();
            try {
                render(<Target />);
                const target = screen.getByTestId("target");

                act(() => {
                    target.dispatchEvent(
                        new PointerEvent("pointerdown", {
                            bubbles: true,
                            clientX: 10,
                            clientY: 10,
                            pointerType: "mouse",
                        }),
                    );
                    vi.advanceTimersByTime(1000);
                });

                // Holding a mouse button down is not a long press; onContextMenu owns
                // the mouse path.
                expect(screen.queryByRole("menu")).not.toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
