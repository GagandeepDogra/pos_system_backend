// CLI: `npm run check:deploy` — reviews the deployment settings in the
// environment (and .env if loaded by the service manager). Exits 1 on failure.
import { reviewDeployment } from './deploy/review';

const result = reviewDeployment(process.env);
console.log(`Deployment profile: ${result.profile?.name ?? process.env.DEPLOY_PROFILE ?? 'lan'}`);
for (const f of result.failures) console.log(`  FAIL  ${f}`);
for (const n of result.notes) console.log(`  note  ${n}`);
console.log(result.ok ? 'Review passed.' : 'Review FAILED.');
process.exit(result.ok ? 0 : 1);
