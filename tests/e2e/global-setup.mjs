import { clearE2EArtifacts, ensureDir, E2E_ARTIFACT_DIR } from './utils.mjs';

export default async function globalSetup() {
  await clearE2EArtifacts();
  await ensureDir(E2E_ARTIFACT_DIR);
}
