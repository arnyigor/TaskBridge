# MCP memory production deployment — DEP-01…05

**Current decision: NO-GO. No production installation has been performed.**
TaskBridge search changes are a separate release; these commands replace only MCP `src/mcp_tools/core.py`.

## Pinned release

- Installation: `G:/AIModels/MCPs/McpServer`.
- Expected original core SHA-256: `a1ab3f84ad5cb6de8e60c54b486d8021271fec10f4079939eb0650474372820b`.
- Candidate SHA-256, canonical UTF-8/LF: `4ee74c0a09844fd92f034bc1ae23bbc354de410eea1b357393c07c7f856fb4e8`.
- Patches, in order: `patch-memory-atomic-save.diff`, then `patch-memory-storage-limits.diff`.
- Any unexpected original/candidate change is NO-GO. Do not change the expected hash merely to bypass a failure.

## Current evidence and blockers

| Gate | Actual result |
|---|---|
| DEP-01 SACL + integrity labels, Markdown/directories/module | **NO-GO**: 128 objects, 128 Win32 1314 errors (required privilege not held). Contents unknown. |
| ADS / special file attributes in that scan | 0 detected; no stream read errors. This says nothing about inaccessible SACL. |
| DEP-02 actual memory-domain MCP stdio | initialize/list_tools, save, inventory, search, history and concurrent saves passed in a synthetic store. |
| Real git | PASS: 3 actual commits in the isolated store; no stub. |
| Real tokenizer | **NO-GO**: the module's `http://127.0.0.1:8080/tokenize` request returns HTTP 400; save reports `tokens=None`. No fake token count accepted. |
| Lifecycle controller / loaded-version proof | **NO-GO**: no reviewed owner-specific adapter has been supplied. |
| DEP runner tests | 15 PASS: orchestration fixtures plus native mutex, controller read-handle, private-backup ACL and junction rejection. No live apply/rollback was run. |

Read-only diagnostics and smoke results are local, ignored artifacts in `.local/deployment-readiness/`.

### Python executable clarification

Configuration launches `.venv/Scripts/python.exe`. `pyvenv.cfg` identifies virtualenv 20.31.2 with CPython 3.12.10 based on `C:/Program Files/Python312/python.exe`. A fresh process through that exact launcher reported:

- `sys.executable`: the `.venv` launcher;
- `sys.prefix`: the `.venv` directory;
- `sys.base_prefix`: the system Python directory;
- MCP dependencies imported from the venv.

The system-Python child is consistent with the Windows virtualenv redirector, not evidence that the venv was bypassed. The existing worker's globals were not introspected. The real smoke records launcher/config/dependency/git hashes; preflight rejects drift in that evidence.

## Safe commands that can run before approval

Use PowerShell from the TaskBridge repository root. These commands never stop a production process or write to the installed tree. Reports/copies go only under `.local`.

```powershell
$ErrorActionPreference = 'Stop'
$env:PYTHONDONTWRITEBYTECODE = '1'
$Install = 'G:/AIModels/MCPs/McpServer'
$Py = "$Install/.venv/Scripts/python.exe"
$Old = 'a1ab3f84ad5cb6de8e60c54b486d8021271fec10f4079939eb0650474372820b'
$New = '4ee74c0a09844fd92f034bc1ae23bbc354de410eea1b357393c07c7f856fb4e8'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Release = ".local/mcp-release-$Stamp"
$Candidate = "$Release/src/mcp_tools/core.py"

if ((Get-FileHash "$Install/src/mcp_tools/core.py" -Algorithm SHA256).Hash.ToLower() -ne $Old) {
    throw 'NO-GO: original core.py changed'
}
if (Test-Path $Release) { throw 'Use a new release directory' }
New-Item -ItemType Directory "$Release/src/mcp_tools" | Out-Null
Copy-Item -LiteralPath "$Install/src/mcp_tools/core.py" -Destination $Candidate
if ((Get-FileHash $Candidate -Algorithm SHA256).Hash.ToLower() -ne $Old) {
    throw 'NO-GO: original changed during copy'
}
# Pass Python via stdin, avoiding Windows PowerShell native -c quoting pitfalls.
function Normalize-CandidateLF([string]$Path) {
@'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_bytes(p.read_text(encoding='utf-8').encode('utf-8'))
'@ | & $Py -B - $Path
    if ($LASTEXITCODE) { throw 'Candidate normalization failed' }
}
# Normalize ONLY the private copy before applying patches.
Normalize-CandidateLF $Candidate
git apply --check --directory=$Release docs/patch-memory-atomic-save.diff
if ($LASTEXITCODE) { throw 'Atomic patch check failed' }
git apply --directory=$Release docs/patch-memory-atomic-save.diff
if ($LASTEXITCODE) { throw 'Atomic patch failed' }
git apply --check --directory=$Release docs/patch-memory-storage-limits.diff
if ($LASTEXITCODE) { throw 'Limits patch check failed' }
git apply --directory=$Release docs/patch-memory-storage-limits.diff
if ($LASTEXITCODE) { throw 'Limits patch failed' }
# git attributes may have produced CRLF. Canonicalize ONLY the staged candidate.
Normalize-CandidateLF $Candidate
if ((Get-FileHash $Candidate -Algorithm SHA256).Hash.ToLower() -ne $New) {
    throw 'NO-GO: candidate SHA mismatch'
}
```

DEP-01 explicitly requests OWNER/GROUP/DACL/SACL/**LABEL** with Win32 APIs. It does not enable privileges, elevate, infer an empty SACL on failure, or follow directory reparse points. It covers the module, relevant ancestor directories, the store directories and Markdown files. Production now needs an independently authorized read-only audit in a token with `SeSecurityPrivilege`; this procedure does not obtain that privilege itself.

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/mcp-deployment-audit.ps1 -InstallRoot $Install
# Exit 0 = metadata gate passed; exit 2 = NO-GO. 1314 requires privilege remediation.
```

A successful audit must also show no unsupported SACL/label ACEs, ADS, special attributes or traversal through junctions. If present, stop and extend/test metadata preservation first. A privilege cannot be replaced by restarting MCP.

DEP-02 uses the **real** `_count_tokens_sync` and `_git_commit_store`, actual venv packages and a new synthetic repository. No user memory/configuration is copied. The script isolates global/system git configuration for the fixture only; the production environment is unchanged.

```powershell
$Smoke = ".local/mcp-real-smoke-$Stamp"
& $Py -B scripts/mcp-deployment-smoke.py --fixture $Smoke --candidate $Candidate --candidate-sha $New --install-root $Install
# Exit 2 or any false gate is NO-GO. Diagnose tokenizer separately; do not substitute a stub.
$SmokeReport = "$Smoke/result.json"
$SmokeSha = (Get-FileHash $SmokeReport -Algorithm SHA256).Hash.ToLower()
$State = ".local/mcp-production-attempt-$Stamp"
& $Py -B scripts/mcp-deployment.py --install-root $Install --candidate $Candidate --state $State --smoke-report $SmokeReport --smoke-report-sha $SmokeSha
# Default mode is preflight. It cannot install or stop a worker.
```

Rebuild/new smoke is required after candidate/import dependencies/venv launcher/config/git changes. Evidence expires after 24 hours. The smoke is memory-domain integration, not verification of every unrelated tool in the all-in-one MCP server, every installed package or the model service's internal state.

## Required lifecycle adapter — currently unavailable

Do not create a no-op controller to make the gate green. A reviewed cwd-local `.ps1` or `.py` adapter is required because the MCP transport is **stdio owned by its client**. A detached `Start-Process python server.py` is not a restart of an attached MCP connection. The owner may respawn children; killing one PID is not a safe quiescence protocol.

Runner parameters passed to the adapter:

```text
-Action <Status|Quiesce|StartRestricted|Probe|Release>
-StateDir <private attempt directory>
-ModulePath <absolute installed core.py>
-ExpectedSha <expected loaded version>
```

The adapter must be self-contained (it executes from a protected verified snapshot, not its original directory); write no secrets or note contents to stdout. Output must be one JSON object, exit 0 and `ok:true`. Its source SHA is approved separately. Unknown dependencies/configuration/lifecycle semantics are blockers, not guessed APIs.

- **Status:** read-only. `lifecycleReady:true` only after identifying ALL owners/writers, entrypoints, attached transports, actual venv/environment and an owner-supported drain/stop/reconnect mechanism. It may not change processes/settings.
- **Quiesce:** close request admission for every owner, disable respawn using the supported owner mechanism, drain in-flight writes/git subprocesses, stop only verified relevant PIDs. Return `admissionClosed:true`. No image-name kill. The runner independently requires zero matching entrypoint processes twice. Alternative `-m`/other writers must be accounted for by the owner; CIM matching alone cannot prove their absence.
- **StartRestricted:** start/reconnect through the owner, with user admission STILL closed, and attest the new attached worker. Do not start an unattached console process.
- **Probe:** perform the checks below against that worker. Return `moduleSha`, `api`, `inventory`, `search`, `save`, `concurrency` and `ok` booleans. `moduleSha` needs startup/in-process provenance bound to the new PID/import; hashing the file or a separate Python subprocess is not sufficient proof. If existing owner facilities cannot provide this, a separately reviewed attestation/bootstrap plan is required. The runner does not edit server.py or owner settings to fabricate it.
- **Release:** open user admission only after verification, and report success.

`StateDir/ledger.json` contains a unique `test_topic`. Before the first stop that ledger is written; Status must tolerate a not-yet-created StateDir. The adapter must use only that fresh topic for mutating checks. For rollback to the original SHA, Probe checks baseline API/inventory/search; it must not falsely require the original implementation to provide the new locking guarantees.

## STOP: operator approval boundary

**The following commands are for a future approved maintenance window only. They have NOT been run.**
They cannot currently pass: DEP-01, DEP-02 and the owner adapter are blocked. `--approve` is an explicit statement that all external writers/editors are excluded; it is not permission inferred from preflight.

After all independent gates are green and the adapter has been implemented/reviewed:

```powershell
$Controller = '.local/mcp-owner-controller.ps1'  # NOT PROVIDED: must be implemented for the actual owner.
if (!(Test-Path -LiteralPath $Controller)) { throw 'NO-GO: lifecycle adapter missing' }
$ControllerSha = (Get-FileHash $Controller -Algorithm SHA256).Hash.ToLower()
$Common = @('--install-root', $Install, '--candidate', $Candidate, '--state', $State,
    '--controller', $Controller, '--controller-sha', $ControllerSha,
    '--smoke-report', $SmokeReport, '--smoke-report-sha', $SmokeSha,
    '--original-sha', $Old, '--candidate-sha', $New)

# Read-only final check first. Inspect JSON; do not continue on nonzero exit.
& $Py -B scripts/mcp-deployment.py @Common
if ($LASTEXITCODE) { throw 'NO-GO: preflight failed' }

# Explicit approval needed for this exact pinned installation and maintenance window:
& $Py -B scripts/mcp-deployment.py @Common --mode apply --approve "DEPLOY:${Old}:NO-EXTERNAL-WRITERS"
if ($LASTEXITCODE) { throw 'Apply failed: inspect ledger, then use approved rollback; do not release admission' }
```

The runner:

1. Acquires an installation-wide Windows named mutex (independent of checkout/cwd).
2. Revalidates original/candidate bytes, environment-bound fresh smoke and full metadata audit; snapshots the reviewed controller privately and holds a read handle denying edits/deletion during execution.
3. Creates a protected private StateDir before copying confidential bytes; writes a recovery ledger.
4. Quiesces/drains all writers through the owner; checks for respawn; repeats original SHA and metadata checks.
5. Saves/validates the original module and a complete store copy including `.history`, `.archive` and git; creates SHA manifest and verifies restoration in `restore-check` while writers remain stopped.
6. Atomically replaces only core.py using immutable approved candidate bytes and copied verified security, with another immediate original-SHA check. No unlink fallback or executable/config replacement.
7. Starts the attached worker restricted; verifies loaded version, API and synthetic checks; ensures ALL preexisting Markdown bytes remain unchanged.
8. Releases user admission only after success. On failure it attempts Quiesce **inside the mutex**; no automatic source/store rollback. Inspect `writers_quiesced_after_error`: false/unknown requires manual intervention.

A stopped/drained set of cooperating writers plus operator exclusion of editors is required for consistency. Double hashing alone is not an atomic snapshot. Background/unknown writers or source drift are NO-GO.

## DEP-05 post-restart checks

The owner adapter must verify and report only aggregate metadata and synthetic results:

- New PID/attached transport and verified candidate import provenance; effective interpreter/prefix match the approved venv.
- MCP initialize/list_tools and `manage_project_memory` availability; TaskBridge search APIs are NOT part of this release.
- Active, archive and history inventory: no preexisting missing/modified Markdown. Expected extra synthetic files must be attributed to the unique test topic.
- Save a short synthetic marker: real numeric token count, real successful git commit, expected new `storage` diagnostics and valid SHA. Never use an existing topic.
- Load and search only that marker; verify full payload and correct provenance.
- Two concurrent saves of that synthetic topic: one success + conflict, or serialized successes with every acknowledged revision represented by final bytes/verified history. No partial Markdown.
- Archive/restore/version-restore only the synthetic topic if exercised; original archives/history remain unchanged. Synthetic history/git/access/journal artifacts are recorded, not silently purged.
- API failure, `tokens=None`, git error/timeout, unexpected original-data change, unproven version or changed executable/environment means NO-GO; keep admission closed.

## Explicit rollback — code only, never wholesale memory restore

```powershell
# Same reviewed controller, install path, candidate, hashes and EXACT StateDir:
& $Py -B scripts/mcp-deployment.py @Common --mode rollback --approve "ROLLBACK:${Old}"
if ($LASTEXITCODE) { throw 'Rollback blocked/failed; keep admission closed and inspect ledger' }
```

Rollback verifies ledger root/versions, original core backup SHA, manifest SHA, current version, audit and current store's UTF-8 compatibility; it quiesces again, refuses unknown module versions, atomically restores the original module and verifies baseline health before release. Valid notes created/changed since deployment are **preserved**; their differing SHA does not disable code-only rollback. The entire store is never rolled back automatically.

If failure occurred before backup completion and original core.py is still intact, rollback can resume the original attached worker without replacing files. Corrupt backups, incompatible current data, unknown source changes, missing privileges or unverifiable provenance require manual recovery. Restoring the old code restores its known concurrency/retention risks; it does not make them safe.

The byte-verified store backup is private recovery material, not a complete NTFS-descriptor restore tool or off-disk disaster backup. Do not restore it over live notes by force. Manual data recovery requires separate approval and preservation of any valid post-deployment changes.

## GO/NO-GO summary

**GO** requires every metadata read to succeed, supported metadata only, known SHA values, fresh successful REAL dependencies, reviewed complete owner lifecycle/provenance, no external writers, protected verified backup/restore, and passing restricted postflight.

**NO-GO today:** SeSecurityPrivilege unavailable (128 × 1314); real tokenizer HTTP400/tokens=None; owner-specific controller and bound loaded-version attestation unavailable. No process stop, production install, production synthetic save or rollback has been run.

Durability guarantee: tested process-crash behavior only. `fsync` of file data does not establish power-loss durability for directory metadata, multiple files or hardware caches. No such guarantee is claimed by this procedure.
