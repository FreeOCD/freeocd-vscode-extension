/**
 * Runtime loader for the DAPjs UMD bundle.
 *
 * Why this exists
 * ---------------
 * The DAPjs UMD bundle (`dap.umd.js`) is copied into `out/` by
 * `CopyWebpackPlugin` at build time. We cannot use a static `import` because:
 *
 *   1. DAPjs ships as UMD, not ESM.
 *   2. webpack resolves `require('./dap.umd.js')` at build time. Because the
 *      file lives in `out/` (not in `src/`), webpack reports
 *      `Module not found` errors during compilation.
 *
 * The fix is to reference the bundle through `__non_webpack_require__`, a
 * webpack 5 built-in that compiles to the original Node.js `require` function
 * in the output bundle. This defers resolution until runtime, when
 * `dap.umd.js` sits next to the compiled `extension.js` / `mcp-server.js` in
 * the `out/` directory.
 */

import { FreeOcdError } from './errors';
import type { DapjsTransport } from '../transport/transport-interface';

// Provided by webpack 5 — replaced with the original Node require() at bundle
// time so that we can resolve modules that webpack shouldn't try to inline.
// See https://webpack.js.org/api/module-variables/#__non_webpack_require__-webpack-specific
declare const __non_webpack_require__: NodeRequire | undefined;

export interface DapjsModule {
  CmsisDAP: new (transport: DapjsTransport, mode: number) => unknown;
  ADI: new (transport: DapjsTransport) => unknown;
  CortexM: new (adi: unknown) => unknown;
  DAPProtocol?: unknown;
}

/**
 * Load the DAPjs UMD bundle that webpack copies to `out/dap.umd.js`.
 *
 * @throws {FreeOcdError} with code `DAPJS_MISSING` if the bundle is absent or
 *   does not expose the expected exports.
 */
export function loadDapjs(): DapjsModule {
  const req: NodeRequire =
    typeof __non_webpack_require__ === 'function'
      ? __non_webpack_require__
      : require;

  let mod: unknown;
  try {
    mod = req('./dap.umd.js');
  } catch (err) {
    throw new FreeOcdError(
      `DAPjs UMD bundle not found (${(err as Error).message}). ` +
        'Run `npm run build:dapjs` and rebuild the extension.',
      'DAPJS_MISSING'
    );
  }

  const dapjs = ((mod as { DAPjs?: DapjsModule })?.DAPjs ?? mod) as DapjsModule;
  if (
    !dapjs ||
    typeof dapjs.CmsisDAP !== 'function' ||
    typeof dapjs.ADI !== 'function' ||
    typeof dapjs.CortexM !== 'function'
  ) {
    throw new FreeOcdError(
      'DAPjs UMD bundle is malformed (missing CmsisDAP/ADI/CortexM). ' +
        'Rebuild with `npm run build:dapjs`.',
      'DAPJS_MISSING'
    );
  }
  return dapjs;
}
