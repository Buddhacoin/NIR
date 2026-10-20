import { createMiningPracticeApp } from "../../blockchain/mining-practice-app.mjs";

// Test-only launcher. Unlike the macOS product CLI, this starts the unmodified
// HTTP app on any host. Requests still use the real Python Iris implementation.
const server = createMiningPracticeApp({ root: process.cwd() });
server.listen(0, "127.0.0.1", () => {
  console.log(`NIR_MODEL_LAB_URL=http://127.0.0.1:${server.address().port}/?local-app=1`);
  console.log(`NIR_MODEL_LAB_SESSION=${server.localSessionToken}`);
});
