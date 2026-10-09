import { applyTheme, getTheme, applyCustomTheme, getCustomTheme, THEME_CHANGED_EVENT, THEME_KEY } from "./lib/theme";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CompanionWindow } from "./components/CompanionWindow";
import "./styles.css";
import "katex/dist/katex.min.css";

applyTheme(getTheme());
applyCustomTheme(getCustomTheme(), getTheme().scheme);
window.addEventListener(THEME_CHANGED_EVENT, () => {applyTheme(getTheme());applyCustomTheme(getCustomTheme(),getTheme().scheme);});
window.addEventListener("storage", event => { if (event.key === THEME_KEY || event.key === "zoompaper.customTheme" || event.key === null) {applyTheme(getTheme());applyCustomTheme(getCustomTheme(),getTheme().scheme);} });

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has("companion") ? <CompanionWindow /> : <App />}
  </React.StrictMode>,
);
