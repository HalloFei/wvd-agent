/** Package entry: the default export is the `WorldDefinition` the loader imports. */
import { WVD_DEFINITION } from './definition.ts';

export default WVD_DEFINITION;
export { WVD_DEFINITION };
export { WVD_CONFIG_GROUP, WVD_DEFAULTS, WVD_ID } from './config.ts';
export type { WvdConfigSection } from './config.ts';
export { WVD_TOOL_DECLS, WvdWorld } from './world.ts';
