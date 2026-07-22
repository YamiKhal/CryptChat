import { useState, useEffect, useRef, ChangeEvent } from "react";
import { useSession } from "@/lib/session";
import { BinaryAsset, bytesToBase64Url } from "@/lib/binary";
import { Vault } from "@/lib/vault";
import { Toggle } from "@/components/ui/Toggle";
import {
    SettingsSection,
    SettingRow,
    SettingBlock,
} from "@/components/settings/SettingsUI";
import { SoundRow } from "@/pages/settings/components/SoundRow";
import {
    SoundSettings,
    DEFAULT_SOUND_SETTINGS,
    configureSounds,
    configureCustomSounds,
    type SoundEvent,
} from "@/lib/sounds";
import { SetStatus } from "@/pages/settings/types";

export default function SoundsTab({
    vault,
    setStatus,
}: {
    vault: Vault;
    setStatus: SetStatus;
}) {
    const session = useSession();

    const [sound, setSound] = useState<SoundSettings>(DEFAULT_SOUND_SETTINGS);
    const [customSounds, setCustomSounds] = useState<
        Partial<Record<SoundEvent, BinaryAsset>>
    >({});

    const soundFileInput = useRef<HTMLInputElement>(null);
    const pendingSoundEvent = useRef<SoundEvent | null>(null);

    useEffect(() => {
        setSound({
            ...DEFAULT_SOUND_SETTINGS,
            ...(vault.preferences.sound ?? {}),
        });
        setCustomSounds(vault.preferences.customSounds ?? {});
    }, [vault]);

    async function updateSound(patch: Partial<SoundSettings>) {
        const prev = sound;
        const next = { ...sound, ...patch };
        setSound(next);
        configureSounds(next);
        try {
            await vault.setPreferences({ sound: next });
            session.refresh();
        } catch (err) {
            setSound(prev);
            configureSounds(prev);
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    function pickCustomSound(event: SoundEvent) {
        pendingSoundEvent.current = event;
        soundFileInput.current?.click();
    }

    async function handleCustomSoundFile(e: ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        const event = pendingSoundEvent.current;
        if (soundFileInput.current) soundFileInput.current.value = "";
        pendingSoundEvent.current = null;
        if (!file || !event) return;

        if (file.size > 1024 * 1024) {
            setStatus({ kind: "error", text: "Sound file must be under 1MB." });
            return;
        }
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const asset: BinaryAsset = {
                mime: file.type || "audio/mpeg",
                data: bytesToBase64Url(bytes),
            };
            const next = { ...customSounds, [event]: asset };
            setCustomSounds(next);
            configureCustomSounds(next);
            await vault.setPreferences({ customSounds: next });
            session.refresh();
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    async function clearCustomSound(event: SoundEvent) {
        const next = { ...customSounds };
        delete next[event];
        setCustomSounds(next);
        configureCustomSounds(next);
        try {
            await vault.setPreferences({ customSounds: next });
            session.refresh();
        } catch (err) {
            setStatus({ kind: "error", text: (err as Error).message });
        }
    }

    return (
        <div className="space-y-8">
            <SettingsSection
                title="Sounds"
                info="Generated on this device and never sent anywhere."
                infoDetails="Every cue is synthesized in your browser — no audio is downloaded and nothing about it leaves the device. These settings are stored locally, like the rest of your display preferences."
            >
                <SettingRow
                    title="Enable sounds"
                    description="Master switch."
                    control={
                        <Toggle
                            checked={sound.enabled}
                            onChange={(v) => updateSound({ enabled: v })}
                            label="Enable sounds"
                        />
                    }
                />
                <SettingBlock>
                    <div className="flex items-center gap-3">
                        <span className="t-h4 text-foreground">Volume</span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            value={Math.round(sound.volume * 100)}
                            disabled={!sound.enabled}
                            onChange={(e) =>
                                updateSound({
                                    volume: Number(e.target.value) / 100,
                                })
                            }
                            className="accent-primary flex-1 disabled:opacity-50"
                            aria-label="Sound volume"
                        />
                        <span className="t-base text-muted w-9 text-right tabular-nums">
                            {Math.round(sound.volume * 100)}%
                        </span>
                    </div>
                </SettingBlock>
            </SettingsSection>

            <SettingsSection
                title="When to play"
                description="▶ preview · ⬆ your own file."
            >
                <SoundRow
                    title="Message from another chat"
                    description="New message in another channel."
                    event="message-in"
                    checked={sound.messageReceived}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ messageReceived: v })}
                    hasCustom={Boolean(customSounds["message-in"])}
                    onPickCustom={() => pickCustomSound("message-in")}
                    onClearCustom={() => clearCustomSound("message-in")}
                />
                <SoundRow
                    title="Message in the open chat"
                    description="Chime in the open chat too."
                    event="message-in-active"
                    checked={sound.messageInActiveChat}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ messageInActiveChat: v })}
                    hasCustom={Boolean(customSounds["message-in-active"])}
                    onPickCustom={() => pickCustomSound("message-in-active")}
                    onClearCustom={() => clearCustomSound("message-in-active")}
                />
                <SoundRow
                    title="Message sent"
                    description="Blip when you send."
                    event="message-sent"
                    checked={sound.messageSent}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ messageSent: v })}
                    hasCustom={Boolean(customSounds["message-sent"])}
                    onPickCustom={() => pickCustomSound("message-sent")}
                    onClearCustom={() => clearCustomSound("message-sent")}
                />
                <SoundRow
                    title="Calls"
                    description="Ring for calls. A custom file loops as the ringtone."
                    event="call-incoming"
                    checked={sound.calls}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ calls: v })}
                    hasCustom={Boolean(customSounds["call-incoming"])}
                    onPickCustom={() => pickCustomSound("call-incoming")}
                    onClearCustom={() => clearCustomSound("call-incoming")}
                />
                <SoundRow
                    title="Keyboard clicks"
                    description="Tick on each keystroke."
                    event="typing"
                    checked={sound.typing}
                    disabled={!sound.enabled}
                    onChange={(v) => updateSound({ typing: v })}
                    hasCustom={Boolean(customSounds["typing"])}
                    onPickCustom={() => pickCustomSound("typing")}
                    onClearCustom={() => clearCustomSound("typing")}
                />
            </SettingsSection>

            <input
                ref={soundFileInput}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={handleCustomSoundFile}
            />
        </div>
    );
}
