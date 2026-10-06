// The identity of the app this build is (open-shell PRD lane 2a): the bridge's one reader,
// bridge/identity.mjs (plugins/<plugin>/identity.json, of the plugin the package.json beside bridge/
// names: app.asar's when the app runs from one, the checkout's otherwise), imported as the shell
// imports the bridge's other modules (bridge-module.mjs: only from inside app.asar when packaged).
import { importBridge } from './bridge-module.mjs';

export const { IDENTITY } = await importBridge('bridge/identity.mjs');
