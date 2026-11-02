/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Removes build outputs (cross-platform replacement for `rm -rf`). Never touches data/.
 */

import fs from 'node:fs';

for (const dir of ['dist', 'dist-electron', 'release']) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[clean] removed ${dir}/`);
}
