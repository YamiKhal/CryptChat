import {
    ShieldCheck,
    Flame,
    Lock,
    Database,
    KeyRound,
    Phone,
    Palette,
    WifiOff,
    EyeOff,
    HardDriveDownload,
    type LucideIcon,
} from "lucide-react";
import type { IconName } from "../content";

/**
 * Resolves the string icon names used in content.ts to their lucide components,
 * so the data file stays free of JSX and any page can render an icon by name.
 */
const MAP: Record<IconName, LucideIcon> = {
    ShieldCheck,
    Flame,
    Lock,
    Database,
    KeyRound,
    Phone,
    Palette,
    WifiOff,
    EyeOff,
    HardDriveDownload,
};

export function Icon({
    name,
    size = 20,
    className = "",
}: {
    name: IconName;
    size?: number;
    className?: string;
}) {
    const C = MAP[name];
    return <C size={size} className={className} aria-hidden="true" />;
}
