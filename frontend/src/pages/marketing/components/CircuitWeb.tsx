import {
    Database,
    Flame,
    KeyRound,
    Lock,
    Phone,
    ShieldCheck,
    type LucideIcon,
} from "lucide-react";

/**
 * Decorative circuit-board webs for the marketing pages: right-angle traces
 * (PCB style, no dots) that route out to feature icons, authored as connected
 * polylines that stop just short of each icon so lines lead to them without
 * crossing. Draws in currentColor only. the caller tints, tilts and fades it.
 *
 * Uniform scale: every preset renders at the same px-per-unit (SCALE), so the
 * stroke weight and icon size read identical across sections. only the canvas
 * size and layout differ, never the element scale. no asset, scales sharp.
 */

type Point = [number, number];

interface Preset {
    /** Authored canvas in SVG units; rendered at w*SCALE px (uniform). */
    w: number;
    h: number;
    /** Each polyline is a connected right-angle trace (corner points). */
    lines: Point[][];
    /** Icons dropped at the end of a trace (traces stop short of these). */
    icons?: { Icon: LucideIcon; x: number; y: number }[];
}

/** Shared px-per-unit. keeps stroke + icon size identical everywhere. */
const SCALE = 1.5;
const STROKE = 1.2;
const ICON_SIZE = 22;

/* ---- hero: connected trunk wired out to the feature icons --------------- */

export const HERO_CIRCUIT: Preset = {
    w: 520,
    h: 380,
    lines: [
        // main horizontal trunk
        [
            [60, 190],
            [460, 190],
        ],
        // Lock (upper-left) + ShieldCheck (lower-left) share a junction
        [
            [120, 190],
            [120, 70],
            [78, 70],
        ],
        [
            [120, 190],
            [120, 310],
            [78, 310],
        ],
        // Phone (top) + Database (bottom) share a junction
        [
            [260, 190],
            [260, 58],
        ],
        [
            [260, 190],
            [260, 322],
        ],
        // KeyRound (upper-right) + Flame (lower-right) share a junction
        [
            [400, 190],
            [400, 70],
            [442, 70],
        ],
        [
            [400, 190],
            [400, 310],
            [442, 310],
        ],
        // detours off the trunk for circuit density (connected both ends)
        [
            [150, 190],
            [150, 168],
            [240, 168],
            [240, 190],
        ],
        [
            [220, 190],
            [220, 212],
            [300, 212],
            [300, 190],
        ],
    ],
    icons: [
        { Icon: Lock, x: 60, y: 70 },
        { Icon: ShieldCheck, x: 60, y: 310 },
        { Icon: Phone, x: 260, y: 40 },
        { Icon: Database, x: 260, y: 340 },
        { Icon: KeyRound, x: 460, y: 70 },
        { Icon: Flame, x: 460, y: 310 },
    ],
};

/* ---- auth: traces emanating from a center node, no icons ---------------- */
// Inner ends sit on a box (±130 from center) so they tuck against the shield
// that renders on top; outer ends run to the edges and bleed past the panel.

export const AUTH_CIRCUIT: Preset = {
    w: 500,
    h: 500,
    lines: [
        // up
        [
            [250, 120],
            [250, 20],
        ],
        [
            [180, 120],
            [180, 60],
            [120, 60],
            [120, 12],
        ],
        [
            [320, 120],
            [320, 50],
            [400, 50],
        ],
        // right
        [
            [380, 250],
            [492, 250],
        ],
        [
            [380, 190],
            [440, 190],
            [440, 120],
        ],
        [
            [380, 300],
            [430, 300],
            [430, 380],
        ],
        // down
        [
            [250, 380],
            [250, 492],
        ],
        [
            [200, 380],
            [200, 440],
            [130, 440],
        ],
        [
            [300, 380],
            [300, 430],
            [380, 430],
        ],
        // left
        [
            [120, 250],
            [8, 250],
        ],
        [
            [120, 190],
            [60, 190],
            [60, 110],
        ],
        [
            [120, 300],
            [70, 300],
            [70, 380],
        ],
    ],
};

/* ------------------------------------------------------------------------- */

export function Circuit({
    preset,
    className = "",
    style,
}: {
    preset: Preset;
    className?: string;
    style?: React.CSSProperties;
}) {
    const { w, h, lines, icons } = preset;
    return (
        <svg
            viewBox={`0 0 ${w} ${h}`}
            width={w * SCALE}
            height={h * SCALE}
            fill="none"
            aria-hidden="true"
            className={className}
            style={style}
        >
            {lines.map((pts, i) => (
                <polyline
                    key={i}
                    points={pts.map(([x, y]) => `${x},${y}`).join(" ")}
                    stroke="currentColor"
                    strokeWidth={STROKE}
                    strokeLinecap="round"
                    strokeLinejoin="miter"
                />
            ))}
            {icons?.map(({ Icon, x, y }, i) => (
                <g
                    key={i}
                    transform={`translate(${x - ICON_SIZE / 2} ${y - ICON_SIZE / 2})`}
                >
                    <Icon
                        width={ICON_SIZE}
                        height={ICON_SIZE}
                        stroke="currentColor"
                        strokeWidth={1.6}
                    />
                </g>
            ))}
        </svg>
    );
}
