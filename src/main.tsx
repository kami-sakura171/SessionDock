import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installExternalLinkHandler } from "./api";
import "./styles.css";

installExternalLinkHandler();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />
);
