import { SESClient } from '@aws-sdk/client-ses';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { runJob } from './lib/job.js';

try {
  await runJob({
    dumpDir: join(dirname(fileURLToPath(import.meta.url)), 'dump'),
    createClient: (region) => new SESClient({ region }),
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
