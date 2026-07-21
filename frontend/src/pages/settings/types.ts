/** Shared types for the settings tabs. */

export type SettingsStatus = {
    kind: "ok" | "error" | "info";
    text: string;
} | null;

export type SetStatus = (status: SettingsStatus) => void;
