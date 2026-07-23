import { useEffect } from "react";
import { useSession } from "@/lib/session";
import { applyCustomThemeVars } from "@/lib/theme";

/**
 * Applies (and, crucially, clears) the premium custom palette as the vault
 * comes and goes.
 *
 * The palette lives in the encrypted vault, so it cannot be read until unlock —
 * the auth screen shows the plain base theme and the override lands once the
 * vault opens. Keyed on the vault instance: unlocking, switching account and
 * locking all change it, so a locked or account-switched screen never keeps the
 * previous identity's colours on the page. Live edits in the customizer apply
 * themselves directly for instant feedback; this covers reload and navigation.
 */
export default function CustomThemeApplier() {
    const { vault } = useSession();

    useEffect(() => {
        const custom = vault?.preferences.customTheme;
        applyCustomThemeVars(
            custom?.enabled ? custom.colors : null,
            custom?.enabled ? custom.bubbles : null,
        );
    }, [vault]);

    return null;
}
