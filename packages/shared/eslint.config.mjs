import baseConfig from '../../eslint.config.mjs';
import { agnosticGlobals } from '../../tools/eslint/agnostic-globals.mjs';

// platform:agnostic — this source runs on browsers, workerd and Hermes, so the
// globals it may reach for are a contract, not a convenience. See the deny list.
export default [...baseConfig, agnosticGlobals];
