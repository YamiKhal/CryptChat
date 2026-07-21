import { Play, Upload, X } from "lucide-react";
import { SettingRow } from "@/components/settings/SettingsUI";
import { Toggle } from "@/components/ui/Toggle";
import { previewSound, type SoundEvent } from "@/lib/sounds";

/**
 * One sound cue: a labelled row with a preview button and an on/off switch. The
 * preview plays regardless of the toggle so you can hear a cue before enabling
 * it; it is still silenced by the master switch being off only insofar as the
 * whole tab greys out (the toggles disable, but the ▶ always previews).
 */
export function SoundRow({
    title,
    description,
    event,
    checked,
    disabled,
    onChange,
    hasCustom,
    onPickCustom,
    onClearCustom,
}: {
    title: string;
    description: string;
    event: SoundEvent;
    checked: boolean;
    disabled?: boolean;
    onChange: (next: boolean) => void;
    /** Whether a custom sound file is installed for this event. */
    hasCustom: boolean;
    onPickCustom: () => void;
    onClearCustom: () => void;
}) {
    return (
        <SettingRow
            title={title}
            description={description}
            control={
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => previewSound(event)}
                        className="text-muted hover:text-primary rounded p-1 transition-colors"
                        title="Test sound"
                        aria-label={`Test the ${title} sound`}
                    >
                        <Play size={13} />
                    </button>
                    {hasCustom ? (
                        <button
                            type="button"
                            onClick={onClearCustom}
                            className="border-primary-line bg-primary-soft t-small text-primary hover:text-error inline-flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors"
                            title="Remove custom sound (back to the built-in cue)"
                        >
                            custom
                            <X size={10} />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={onPickCustom}
                            className="text-muted hover:text-primary rounded p-1 transition-colors"
                            title="Use a custom sound file"
                            aria-label={`Choose a custom sound for ${title}`}
                        >
                            <Upload size={13} />
                        </button>
                    )}
                    <Toggle
                        checked={checked}
                        onChange={onChange}
                        disabled={disabled}
                        label={title}
                    />
                </div>
            }
        />
    );
}
