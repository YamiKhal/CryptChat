import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "@/App";
import { SessionProvider } from "@/lib/session";
import { applyTheme, getTheme } from "@/lib/theme";
import CustomThemeApplier from "@/components/theme/CustomThemeApplier";
import "./index.css";

applyTheme(getTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <BrowserRouter>
            <SessionProvider>
                <CustomThemeApplier />
                <App />
            </SessionProvider>
        </BrowserRouter>
    </React.StrictMode>,
);
