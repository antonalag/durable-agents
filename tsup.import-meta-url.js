import { pathToFileURL } from "node:url";

export const importMetaUrlShim = pathToFileURL(__filename).href;
