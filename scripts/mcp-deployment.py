"""DEP-03/04/05: fail-closed, explicitly approved MCP deployment/rollback.
Default mode is read-only preflight (only reports under cwd/.local are written).
A reviewed owner-specific controller is REQUIRED; this script never kills by name
or starts an unattached stdio server. See docs/MCP_DEPLOYMENT.md for its contract.
"""
import argparse
import contextlib
import ast
import hashlib
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import time
import uuid

BASELINE_SHA = 'a1ab3f84ad5cb6de8e60c54b486d8021271fec10f4079939eb0650474372820b'
CANDIDATE_SHA = '4ee74c0a09844fd92f034bc1ae23bbc354de410eea1b357393c07c7f856fb4e8'
SCRIPTS = Path(__file__).resolve().parent
SMOKE_DEPENDENCIES = ('src/__init__.py', 'src/constants.py', 'src/utils.py',
    'src/mcp_tools/__init__.py', 'src/mcp_tools/common.py', 'src/tools/__init__.py',
    'src/tools/context_compressor.py', 'src/tools/python_exec.py', 'src/tools/jvm_exec.py')



def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def local_path(value):
    reject_reparse_chain(value)
    result = Path(value).resolve()
    require(result.is_relative_to(Path.cwd().resolve() / '.local'), 'state must be under cwd/.local')
    return result


def write_json(path, value):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temp.open('x', encoding='utf-8') as handle:
            json.dump(value, handle, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def reject_reparse_chain(path):
    original = Path(path).absolute()
    for item in (original, *original.parents):
        try:
            st = item.lstat()
        except FileNotFoundError:
            continue
        require(not item.is_symlink() and not (getattr(st, 'st_file_attributes', 0) & 0x400),
                'reparse point in deployment path; refused')


@contextlib.contextmanager
def deployment_lock(install_root):
    # Machine-wide, independent of checkout/cwd and held through failure cleanup.
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateMutexW
    create.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    create.restype = wintypes.HANDLE
    wait = kernel.WaitForSingleObject
    wait.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    wait.restype = wintypes.DWORD
    release, close = kernel.ReleaseMutex, kernel.CloseHandle
    release.argtypes = close.argtypes = [wintypes.HANDLE]
    release.restype = close.restype = wintypes.BOOL
    key = hashlib.sha256(str(Path(install_root).resolve()).lower().encode()).hexdigest()
    handle = create(None, False, r'Global\TaskBridgeMcpDeployment_' + key)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    acquired = False
    try:
        outcome = wait(handle, 0)
        require(outcome in (0, 0x80), 'another deployment owns this installation')
        acquired = True
        yield
    finally:
        if acquired: release(handle)
        close(handle)



@contextlib.contextmanager
def verified_controller_snapshot(path, expected):
    # Hold a Windows read handle denying writes/deletion while the interpreter
    # opens the protected snapshot. Hash the bytes under that handle's lifetime.
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    handle = create(str(path), 0x80000000, 0x1, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        require(sha(path) == expected, 'controller snapshot SHA mismatch')
        yield
    finally:
        close(handle)


def security_helpers(candidate_bytes):
    # Reuse the tested implementation without importing MCP or touching its store.
    tree = ast.parse(candidate_bytes.decode('utf-8'))
    functions = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                 and n.name in ('_copy_file_security', '_write_durable')]
    require(len(functions) == 2, 'candidate security helpers missing')
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    ns = {'os': os, 'Path': Path}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, *functions], type_ignores=[])),
                 '<verified-candidate>', 'exec'), ns)
    return ns['_write_durable']


class Deployment:
    def __init__(self, args):
        self.args = args
        reject_reparse_chain(args.install_root)
        self.root = Path(args.install_root).resolve()
        self.module = self.root / 'src/mcp_tools/core.py'
        reject_reparse_chain(self.module)
        reject_reparse_chain(self.root / 'data/persistent_memory')
        require(self.module.resolve().is_relative_to(self.root), 'module escapes install root')
        reject_reparse_chain(args.candidate)
        self.candidate = Path(args.candidate).resolve()
        self.state = local_path(args.state)
        self.ledger = self.state / 'ledger.json'
        self.mutation_started = False
        self._candidate_bytes = None
        self._controller_snapshot = None

    def controller(self, action, expected):
        a = self.args
        require(a.controller and a.controller_sha, 'reviewed lifecycle controller required')
        if self._controller_snapshot is None:
            import tempfile
            reject_reparse_chain(a.controller)
            original = Path(a.controller).resolve()
            require(original.is_relative_to(Path.cwd().resolve()), 'controller must be a reviewed cwd-local file')
            data = original.read_bytes()
            require(hashlib.sha256(data).hexdigest() == a.controller_sha, 'controller SHA changed')
            require(original.suffix in ('.py', '.ps1'), 'unsupported controller type')
            cache = Path.cwd() / '.local'
            cache.mkdir(exist_ok=True)
            reject_reparse_chain(cache)
            directory = Path(tempfile.mkdtemp(prefix='dep-controller-', dir=cache))
            self.protect_directory(directory)
            script = directory / ('controller' + original.suffix)
            with script.open('xb') as handle:
                handle.write(data); handle.flush(); os.fsync(handle.fileno())
            require(sha(script) == a.controller_sha, 'controller snapshot mismatch')
            self._controller_snapshot = script
        script = self._controller_snapshot
        require(sha(script) == a.controller_sha, 'protected controller snapshot changed')
        prefix = [sys.executable, '-B'] if script.suffix == '.py' else ['powershell.exe', '-NoProfile', '-NonInteractive', '-File']
        require(script.suffix in ('.py', '.ps1'), 'controller must be .py or .ps1')
        command = [*prefix, str(script), '-Action', action, '-StateDir', str(self.state),
                   '-ModulePath', str(self.module), '-ExpectedSha', expected]
        with verified_controller_snapshot(script, a.controller_sha):
            run = subprocess.run(command, capture_output=True, text=True, timeout=90)
        require(run.returncode == 0, 'controller failed: ' + action)
        result = json.loads(run.stdout)
        require(result.get('ok') is True, 'controller did not attest success: ' + action)
        return result

    def writers(self):
        # Inventory only. Includes launchers and workers for this exact entrypoint.
        command = r"""$p=$env:TASKBRIDGE_DEP_SERVER.Replace('\','/').ToLower();
@(Get-CimInstance Win32_Process | Where-Object {
 $_.Name -match '^python(w)?\.exe$' -and $_.CommandLine -and
 $_.CommandLine.Replace('\','/').ToLower().Contains($p)
} | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress"""
        env = {**os.environ, 'TASKBRIDGE_DEP_SERVER': str(self.root / 'server.py')}
        run = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                             env=env, capture_output=True, text=True, check=True, timeout=20)
        result = json.loads(run.stdout or '[]')
        return result if isinstance(result, list) else [result]

    def audit(self):
        run = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-File',
                              str(SCRIPTS / 'mcp-deployment-audit.ps1'), '-InstallRoot', str(self.root)],
                             capture_output=True, text=True, timeout=90)
        result = json.loads(run.stdout)
        require(run.returncode in (0, 2), 'metadata audit failed unexpectedly')
        return result

    def candidate_bytes(self):
        if self._candidate_bytes is None:
            data = self.candidate.read_bytes()
            require(hashlib.sha256(data).hexdigest() == self.args.candidate_sha, 'candidate SHA mismatch')
            self._candidate_bytes = data
        return self._candidate_bytes

    def preflight(self):
        a = self.args
        require(os.name == 'nt', 'this deployment procedure targets Windows only')
        require(sha(self.module) == a.original_sha, 'NO-GO: installed core.py SHA changed')
        require(self.candidate.is_relative_to(Path.cwd().resolve()), 'candidate must be cwd-local')
        require(sha(self.candidate) == a.candidate_sha, 'NO-GO: candidate SHA mismatch')
        compile(self.candidate_bytes(), str(self.candidate), 'exec')
        require(not self.state.is_relative_to(self.root) and not self.root.is_relative_to(self.state),
                'state and installed root must not overlap')
        audit = self.audit()
        smoke = None
        if a.smoke_report and a.smoke_report_sha:
            p = local_path(a.smoke_report)
            require(sha(p) == a.smoke_report_sha, 'smoke report SHA mismatch')
            require(time.time() - p.stat().st_mtime < 24 * 3600, 'smoke report expired')
            smoke = json.loads(p.read_text(encoding='utf-8'))
        blockers = []
        if not audit.get('go'): blockers.append('DEP-01 metadata audit NO-GO')
        if not smoke or not smoke.get('go') or smoke.get('candidate_sha') != a.candidate_sha:
            blockers.append('DEP-02 real-dependency smoke missing/NO-GO')
        if smoke:
            python = self.root / '.venv/Scripts/python.exe'
            git = shutil.which('git')
            deps = smoke.get('dependencies_sha', {})
            environment_ok = (
                Path(smoke.get('prefix', '')).resolve() == self.root / '.venv'
                and Path(smoke.get('python', '')).resolve() == python
                and smoke.get('python_sha') == sha(python)
                and smoke.get('pyvenv_cfg_sha') == sha(self.root / '.venv/pyvenv.cfg')
                and set(deps) == set(SMOKE_DEPENDENCIES)
                and all(deps.get(rel) == sha(self.root / rel) for rel in SMOKE_DEPENDENCIES)
                and git and smoke.get('git_executable') == git
                and smoke.get('git_sha') == sha(git))
            if not environment_ok:
                blockers.append('DEP-02 environment/dependencies changed or unattested')
        if not a.controller or not a.controller_sha:
            blockers.append('reviewed lifecycle controller missing')
        else:
            status = self.controller('Status', a.original_sha)
            if status.get('lifecycleReady') is not True:
                blockers.append('controller cannot attest owner lifecycle')
        return {'go': not blockers, 'blockers': blockers, 'audit': audit,
                'original_sha': a.original_sha, 'candidate_sha': a.candidate_sha,
                'writers': self.writers(), 'smoke': smoke}

    def stopped(self, expected):
        status = self.controller('Quiesce', expected)
        require(status.get('admissionClosed') is True, 'writer admission is not closed')
        require(not self.writers(), 'MCP writer remains after Quiesce')
        time.sleep(1)
        require(not self.writers(), 'writer respawned: controller did not disable admission')

    def protect_state(self):
        require(not self.state.exists(), 'apply requires a NEW state directory')
        self.state.mkdir(parents=True)
        self.protect_directory(self.state)

    def protect_directory(self, directory):
        # Protect the private directory before copying any memory or source bytes.
        command = '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
        sid = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                             capture_output=True, text=True, check=True, timeout=15).stdout.strip()
        require(sid.startswith('S-1-'), 'could not determine backup owner')
        icacls = str(Path(os.environ['SystemRoot']) / 'System32/icacls.exe')
        run = subprocess.run([icacls, str(directory), '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F'],
                             capture_output=True, timeout=15)
        require(run.returncode == 0, 'could not protect private backup directory')

    def replace(self, data, expected_current, security_source, expected_result):
        require(sha(self.module) == expected_current, 'module changed before replacement')
        require(sha(self.candidate) == self.args.candidate_sha, 'candidate changed before replacement')
        require(hashlib.sha256(data).hexdigest() == expected_result, 'replacement bytes are not approved')
        write = security_helpers(self.candidate_bytes())
        temp = self.module.with_name('.core.' + uuid.uuid4().hex + '.tmp')
        try:
            write(temp, data, security_source=security_source)
            require(sha(self.module) == expected_current, 'module changed during staging')
            os.replace(temp, self.module)
        finally:
            temp.unlink(missing_ok=True)
        require(sha(self.module) == expected_result, 'replacement verification failed')

    def original_notes_unchanged(self, manifest):
        report = json.loads(manifest.read_text(encoding='utf-8'))
        store = self.root / 'data/persistent_memory'
        for item in report['files']:
            rel = Path(item['path'])
            require(not rel.is_absolute() and '..' not in rel.parts, 'invalid backup manifest path')
            if rel.suffix.lower() == '.md':
                require(sha(store / rel) == item['sha256'], 'original Markdown changed; manual recovery required')

    def verify_started(self, expected, original_manifest, full=True):
        require(sha(self.module) == expected, 'installed module SHA mismatch')
        self.controller('StartRestricted', expected)
        require(bool(self.writers()), 'controller started no attached MCP worker')
        proof = self.controller('Probe', expected)
        keys = ('api', 'inventory', 'search', 'save', 'concurrency') if full else ('api', 'inventory', 'search')
        for key in keys:
            require(proof.get(key) is True, 'postflight failed: ' + key)
        require(proof.get('moduleSha') == expected, 'loaded version provenance missing/mismatched')
        if original_manifest is not None:
            self.original_notes_unchanged(original_manifest)
        return proof

    def apply(self):
        a = self.args
        require(a.approve == 'DEPLOY:' + a.original_sha + ':NO-EXTERNAL-WRITERS', 'explicit deployment approval required')
        report = self.preflight()
        require(report['go'], 'NO-GO: ' + '; '.join(report['blockers']))
        self.candidate_bytes()
        self.protect_state()
        write_json(self.state / 'preflight.json', report)
        receipt = {'phase': 'prepared', 'install_root': str(self.root),
                   'original_sha': a.original_sha, 'candidate_sha': a.candidate_sha,
                   'test_topic': 'depcheck-' + uuid.uuid4().hex}
        write_json(self.ledger, receipt)
        # No Stop-Process calls: only the reviewed owner controller can stop stdio.
        self.mutation_started = True
        self.stopped(a.original_sha)
        receipt['phase'] = 'stopped'
        write_json(self.ledger, receipt)
        require(sha(self.module) == a.original_sha, 'source changed after stop')
        require(self.audit().get('go') is True, 'metadata changed or unreadable after stop')
        security_helpers(self.candidate_bytes())(self.state / 'core.original.py', self.module.read_bytes(), security_source=self.module)
        require(sha(self.state / 'core.original.py') == a.original_sha, 'module backup mismatch')
        run = subprocess.run(['node', str(SCRIPTS / 'backup-memory-store.mjs'),
             '--source', str(self.root / 'data/persistent_memory'),
             '--destination', str(self.state / 'store'), '--verify-into', str(self.state / 'restore-check')],
             capture_output=True, text=True, timeout=120)
        require(run.returncode == 0, 'stopped-writer backup/restore failed')
        backup = json.loads(run.stdout)
        require(backup['consistent'] and backup['restore']['ok'], 'backup is not verified')
        manifest = self.state / 'store/manifest.json'
        receipt.update(phase='backup-verified', manifest_sha=sha(manifest))
        write_json(self.ledger, receipt)
        require(not self.writers(), 'writer appeared before installation')
        self.replace(self.candidate_bytes(), a.original_sha, self.module, a.candidate_sha)
        receipt['phase'] = 'installed'
        write_json(self.ledger, receipt)
        proof = self.verify_started(a.candidate_sha, manifest)
        receipt.update(phase='verified', postflight=proof)
        write_json(self.ledger, receipt)
        self.controller('Release', a.candidate_sha)
        receipt['phase'] = 'released'
        write_json(self.ledger, receipt)
        return {'go': True, 'phase': receipt['phase']}

    def current_store_compatible(self):
        store = self.root / 'data/persistent_memory'
        paths = list(store.glob('*.md'))
        stack = [store / f for f in ('.archive', '.history') if (store / f).exists()]
        while stack:
            directory = stack.pop()
            reject_reparse_chain(directory)
            for entry in directory.iterdir():
                reject_reparse_chain(entry)
                if entry.is_dir(): stack.append(entry)
                elif entry.suffix.lower() == '.md': paths.append(entry)
        for path in paths:
            reject_reparse_chain(path)
            try:
                path.read_bytes().decode('utf-8')
            except UnicodeError:
                raise RuntimeError('current store is not legacy UTF-8 compatible') from None
        return len(paths)

    def rollback(self):
        a = self.args
        require(a.approve == 'ROLLBACK:' + a.original_sha, 'explicit rollback approval required')
        receipt = json.loads(self.ledger.read_text(encoding='utf-8'))
        require(receipt['install_root'] == str(self.root), 'rollback root mismatch')
        require(receipt['original_sha'] == a.original_sha and receipt['candidate_sha'] == a.candidate_sha,
                'rollback version mismatch')
        require(sha(self.candidate) == a.candidate_sha, 'rollback security helper changed')
        backup = self.state / 'core.original.py'
        manifest = self.state / 'store/manifest.json'
        current = sha(self.module)
        require(current in (a.original_sha, a.candidate_sha), 'unexpected module version; refusing rollback')
        resume_only = receipt['phase'] in ('prepared', 'stopped') and current == a.original_sha
        if not resume_only:
            require(sha(backup) == a.original_sha and sha(manifest) == receipt['manifest_sha'], 'rollback backup tampered')
            require(self.audit().get('go') is True, 'rollback metadata audit NO-GO')
        self.candidate_bytes()
        self.current_store_compatible()
        self.mutation_started = True
        self.stopped(current)
        self.current_store_compatible()
        if not resume_only:
            require(self.audit().get('go') is True, 'rollback metadata changed after stop')
        # Never replace the entire live memory store: that could discard valid writes.
        if current != a.original_sha:
            self.replace(backup.read_bytes(), current, backup, a.original_sha)
        proof = self.verify_started(a.original_sha, None, full=False)
        receipt.update(phase='rollback-verified', rollback_postflight=proof)
        write_json(self.ledger, receipt)
        self.controller('Release', a.original_sha)
        return {'go': True, 'phase': 'rollback-verified'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mode', choices=['preflight', 'apply', 'rollback'], default='preflight')
    p.add_argument('--install-root', required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--state', required=True)
    p.add_argument('--original-sha', default=BASELINE_SHA)
    p.add_argument('--candidate-sha', default=CANDIDATE_SHA)
    p.add_argument('--controller')
    p.add_argument('--controller-sha')
    p.add_argument('--smoke-report')
    p.add_argument('--smoke-report-sha')
    p.add_argument('--approve')
    args = p.parse_args()
    try:
        quiesced = None
        deployment = Deployment(args)
        if args.mode == 'preflight':
            result = deployment.preflight()
        else:
            require(os.name == 'nt', 'Windows deployment only')
            with deployment_lock(args.install_root):
                try:
                    result = getattr(deployment, args.mode)()
                except Exception:
                    if deployment.mutation_started:
                        try:
                            deployment.stopped(sha(deployment.module))
                            quiesced = True
                        except Exception:
                            quiesced = False
                    raise
        print(json.dumps(result, indent=2))
        return 0 if result.get('go') else 2
    except Exception as exc:
        # Do not dump note data or callback stdout. On failure admission stays
        # closed; use the explicit rollback command only after inspecting ledger.
        # OSError may include a private note path; never emit it.
        message = type(exc).__name__ if isinstance(exc, OSError) else str(exc)
        print(json.dumps({'go': False, 'error': message, 'automatic_rollback': False,
                          'writers_quiesced_after_error': quiesced}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
