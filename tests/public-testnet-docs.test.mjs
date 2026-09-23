import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const matrix = read("docs/public-testnet-gates.md");
const security = read("SECURITY.md");
const network = read("docs/network.md");

test("public developer-testnet matrix has one complete ordered gate table", () => {
  assert.match(matrix,
    /\| Gate \| Command \| Artifact \| Machine-verifiable evidence \| External manual criterion \|/u);

  const rows = matrix.split("\n").filter((line) => /^\| \d+\. /u.test(line));
  assert.deepEqual(rows.map((row) => Number(/^\| (\d+)\./u.exec(row)[1])),
    Array.from({ length: 15 }, (_, index) => index));
  for (const row of rows) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 5, "every gate must retain all five columns");
    assert.equal(cells.every(Boolean), true, "every gate cell must be populated");
  }

  assert.match(matrix, /## Free volunteer-machine path/u);
  assert.match(matrix, /## Optional paid services/u);
  assert.match(matrix, /recoveryStateCommitment/u);
  assert.match(matrix, /EVIDENCE-CONSISTENCY-PASS/u);
  assert.match(matrix, /does not prove this/u);
  assert.match(matrix, /There is no automatic fork choice/u);
});

test("operator runbooks link to the canonical matrix", () => {
  const runbooks = [
    "docs/launch-readiness.md",
    "docs/developer-testnet-preflight.md",
    "docs/validator-ceremony-onboarding.md",
    "docs/certificate-lifecycle.md",
    "docs/backup-recovery-drills.md",
    "docs/testnet-partition-drill.md",
    "docs/multi-host-launch-evidence.md",
    "docs/genesis-ceremony.md",
    "docs/testnet-reset.md"
  ];
  for (const path of runbooks) {
    assert.match(read(path), /public-testnet-gates\.md/u, `${path} must link the matrix`);
  }
  assert.match(security, /docs\/public-testnet-gates\.md/u);
});

test("security and network status do not retain superseded recovery claims", () => {
  const staleClaims = [
    "does not yet score or fail over across multiple seeds automatically",
    "There is no fork recovery or checkpoint/snapshot sync",
    "durable network snapshot installation, pruning, remote backup coordination",
    "Joining-node installation, validator-rotation proofs, journal-tail",
    "There is no fork recovery or network snapshot synchronization",
    "authenticated transport sessions",
    "Automated certificate lifecycle and coordinator-key rotation are not governed"
  ];
  for (const claim of staleClaims) {
    assert.equal(`${security}\n${network}`.includes(claim), false,
      `superseded claim remains: ${claim}`);
  }

  assert.match(security, /multiple distinct authenticated seeds/u);
  assert.match(security, /Quorum-authenticated snapshot selection/u);
  assert.match(security, /Before any real-value network/u);
  assert.match(network, /Authenticated snapshot synchronization/u);
  assert.match(network, /automatic fork choice/u);
});

test("matrix commands refer to existing package scripts and CLI files", () => {
  const packageJson = JSON.parse(read("package.json"));
  const requiredScripts = [
    "release:create", "release:sign", "release:verify", "release:bundle-create",
    "release:bundle-sign", "release:bundle-verify", "release:witness",
    "genesis:ceremony", "validator:ceremony",
    "certificate:lifecycle", "certificate:bootstrap", "network:validator",
    "network:discover", "beacon:serve", "beacon:aggregate", "node:backup",
    "backup:receipt", "backup:serve", "backup:drill-remote", "testnet:reset"
  ];
  for (const script of requiredScripts) {
    assert.equal(typeof packageJson.scripts[script], "string", `missing npm script ${script}`);
    assert.ok(matrix.includes(`npm run ${script}`), `matrix must name npm run ${script}`);
  }

  for (const cli of [
    "blockchain/developer-testnet-preflight-cli.mjs",
    "blockchain/testnet-partition-drill-cli.mjs",
    "blockchain/multi-host-launch-evidence-cli.mjs"
  ]) {
    assert.doesNotThrow(() => readFileSync(new URL(`../${cli}`, import.meta.url)));
    assert.ok(matrix.includes(`node ${cli}`), `matrix must name ${cli}`);
  }
});
