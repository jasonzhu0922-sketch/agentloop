import { bootAdminWeb } from "./shell.ts";

const root = document.querySelector<HTMLElement>("#root");
if (root !== null) bootAdminWeb(root);
