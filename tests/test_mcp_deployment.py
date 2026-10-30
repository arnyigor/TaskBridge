"""Orchestration tests only: mocked owner/audit/backup, synthetic files.
Native persistence/NTFS behavior is tested in test_legacy_memory_persistence.py.
No real processes are stopped, no live MCP or tokenizer is called.
"""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location('mcp_deployment', Path(__file__).resolve().parents[1] / 'scripts/mcp-deployment.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FixtureDeployment(m.Deployment):
    def __init__(self, args):
        super().__init__(args)
        self.actions = []
        self.running = [999]
        self.fail_health = False

    def audit(self):
        return {'go': True}

    def writers(self):
        return self.running[:]

    def preflight(self):
        m.require(m.sha(self.module) == self.args.original_sha, 'source SHA changed')
        return {'go': True, 'blockers': []}

    def protect_state(self):
        self.state.mkdir()

    def controller(self, action, expected):
        self.actions.append(action)
        if action == 'Quiesce': self.running = []
        if action == 'StartRestricted': self.running = [1000]
        if action == 'Probe' and self.fail_health: raise RuntimeError('health failed')
        return {'ok': True, 'admissionClosed': action == 'Quiesce', 'moduleSha': expected,
                **dict.fromkeys(('api', 'inventory', 'search', 'save', 'concurrency'), True)}


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    # Tests must be invoked with --basetemp inside cwd/.local.
    root = tmp_path / 'install'
    module = root / 'src/mcp_tools/core.py'
    module.parent.mkdir(parents=True)
    module.write_bytes(b'value = 1\n')
    store = root / 'data/persistent_memory'
    store.mkdir(parents=True)
    (store / 'existing.md').write_bytes(b'existing fixture knowledge')
    candidate = tmp_path / 'candidate.py'
    candidate.write_bytes(b'value = 2\n')
    args = SimpleNamespace(install_root=str(root), candidate=str(candidate), state=str(tmp_path / 'attempt'),
        original_sha=m.sha(module), candidate_sha=m.sha(candidate), controller=None, controller_sha=None,
        smoke_report=None, smoke_report_sha=None, approve=None)
    args.approve = 'DEPLOY:' + args.original_sha + ':NO-EXTERNAL-WRITERS'
    d = FixtureDeployment(args)
    monkeypatch.setattr(m.time, 'sleep', lambda seconds: None)
    def write(path, data, security_source=None):
        with path.open('xb') as handle: handle.write(data)
    monkeypatch.setattr(m, 'security_helpers', lambda candidate: write)
    def backup(command, **kwargs):
        assert command[0] == 'node'
        assert d.running == [], 'backup happened before writer stop'
        destination = d.state / 'store'
        destination.mkdir()
        files = [{'path': p.name, 'sha256': m.sha(p)} for p in store.glob('*.md')]
        m.write_json(destination / 'manifest.json', {'destination': str(destination), 'files': files})
        return SimpleNamespace(returncode=0, stdout=json.dumps({'consistent': True, 'restore': {'ok': True}}))
    monkeypatch.setattr(m.subprocess, 'run', backup)
    return d


def test_wrong_approval_never_stops_writer(deployment):
    d = deployment
    d.args.approve = 'not-approved'
    with pytest.raises(RuntimeError, match='approval'): d.apply()
    assert not d.actions
    assert not d.state.exists()


def test_source_drift_aborts_before_stop(deployment):
    d = deployment
    d.module.write_bytes(b'unexpected external edit')
    with pytest.raises(RuntimeError, match='SHA'): d.apply()
    assert not d.actions
    assert d.module.read_bytes() == b'unexpected external edit'


def test_apply_then_explicit_rollback_preserves_existing_memory(deployment):
    d = deployment
    assert d.apply()['phase'] == 'released'
    assert m.sha(d.module) == d.args.candidate_sha
    assert d.actions == ['Quiesce', 'StartRestricted', 'Probe', 'Release']
    d.args.approve = 'ROLLBACK:' + d.args.original_sha
    assert d.rollback()['phase'] == 'rollback-verified'
    assert m.sha(d.module) == d.args.original_sha
    assert (d.root / 'data/persistent_memory/existing.md').read_bytes() == b'existing fixture knowledge'


def test_health_failure_does_not_release_and_rollback_is_possible(deployment):
    d = deployment
    d.fail_health = True
    with pytest.raises(RuntimeError, match='health'): d.apply()
    assert 'Release' not in d.actions
    assert json.loads(d.ledger.read_text())['phase'] == 'installed'
    d.fail_health = False
    d.args.approve = 'ROLLBACK:' + d.args.original_sha
    assert d.rollback()['go']
    assert m.sha(d.module) == d.args.original_sha


def test_tampered_backup_is_not_restored(deployment):
    d = deployment
    d.apply()
    (d.state / 'core.original.py').write_bytes(b'tampered')
    d.args.approve = 'ROLLBACK:' + d.args.original_sha
    actions = len(d.actions)
    with pytest.raises(RuntimeError, match='tampered'): d.rollback()
    assert len(d.actions) == actions
    assert m.sha(d.module) == d.args.candidate_sha


def test_unknown_installed_version_is_not_overwritten_on_rollback(deployment):
    d = deployment
    d.apply()
    d.module.write_bytes(b'unknown version')
    d.args.approve = 'ROLLBACK:' + d.args.original_sha
    with pytest.raises(RuntimeError, match='unexpected'): d.rollback()
    assert d.module.read_bytes() == b'unknown version'


def test_code_only_rollback_preserves_valid_user_markdown_changes(deployment):
    d = deployment
    d.apply()
    note = d.root / 'data/persistent_memory/existing.md'
    note.write_bytes(b'valid new user change')
    d.args.approve = 'ROLLBACK:' + d.args.original_sha
    assert d.rollback()['go']
    assert m.sha(d.module) == d.args.original_sha
    assert note.read_bytes() == b'valid new user change'


def test_pre_backup_failure_can_resume_unchanged_original(deployment):
    d = deployment
    d.state.mkdir()
    m.write_json(d.ledger, {'phase': 'stopped', 'install_root': str(d.root),
                          'original_sha': d.args.original_sha, 'candidate_sha': d.args.candidate_sha})
    d.running = []
    d.args.approve = 'ROLLBACK:' + d.args.original_sha
    assert d.rollback()['go']
    assert m.sha(d.module) == d.args.original_sha


def test_unapproved_replacement_bytes_are_rejected(deployment):
    d = deployment
    before = d.module.read_bytes()
    with pytest.raises(RuntimeError, match='not approved'):
        d.replace(b'unapproved', d.args.original_sha, d.module, d.args.candidate_sha)
    assert d.module.read_bytes() == before


def test_candidate_change_after_approval_never_installs_unknown_bytes(deployment):
    d = deployment
    approved = d.candidate_bytes()
    d.candidate.write_bytes(b'changed after approval')
    assert d.candidate_bytes() == approved
    with pytest.raises(RuntimeError, match='candidate changed'):
        d.replace(approved, d.args.original_sha, d.module, d.args.candidate_sha)
    assert m.sha(d.module) == d.args.original_sha


@pytest.mark.skipif(m.os.name != 'nt', reason='Windows named mutex')
def test_mutex_excludes_another_checkout(tmp_path):
    import subprocess
    import sys
    other = tmp_path / 'other-checkout'
    other.mkdir()
    root = tmp_path / 'synthetic-install'
    child = '''import importlib.util, sys
s=importlib.util.spec_from_file_location('deployment',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
try:
 with m.deployment_lock(sys.argv[2]): sys.exit(0)
except RuntimeError: sys.exit(2)
'''
    with m.deployment_lock(root):
        result = subprocess.run([sys.executable, '-B', '-c', child, str(Path(m.__file__).resolve()), str(root)],
                                cwd=other, capture_output=True, timeout=15)
        assert result.returncode == 2


@pytest.mark.skipif(m.os.name != 'nt', reason='Windows file handle sharing')
def test_controller_snapshot_cannot_change_during_execution(tmp_path):
    script = tmp_path / 'controller.py'
    script.write_bytes(b'approved')
    with m.verified_controller_snapshot(script, m.sha(script)):
        with pytest.raises(PermissionError): script.write_bytes(b'changed')
    assert script.read_bytes() == b'approved'


@pytest.mark.skipif(m.os.name != 'nt', reason='Windows junctions')
def test_directory_junction_is_rejected_before_traversal(tmp_path):
    import subprocess
    import os
    target, link = tmp_path / 'target', tmp_path / 'junction'
    target.mkdir()
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
        'New-Item -ItemType Junction -Path $env:DEP_TEST_LINK -Value $env:DEP_TEST_TARGET | Out-Null'],
        env={**os.environ, 'DEP_TEST_LINK': str(link), 'DEP_TEST_TARGET': str(target)},
        capture_output=True, timeout=15)
    assert result.returncode == 0
    try:
        with pytest.raises(RuntimeError, match='reparse'):
            m.reject_reparse_chain(link / 'child')
    finally:
        os.rmdir(link)
    assert target.is_dir()


@pytest.mark.skipif(m.os.name != 'nt', reason='Windows backup directory ACL')
def test_private_backup_directory_is_protected_before_data_copy(tmp_path):
    import os
    import subprocess
    private = tmp_path / 'private-backup'
    private.mkdir()
    m.Deployment.protect_directory(None, private)
    command = '$a=Get-Acl -LiteralPath $env:DEP_TEST_PRIVATE; [pscustomobject]@{protected=$a.AreAccessRulesProtected; rules=@($a.Access).Count; inherited=@($a.Access | Where-Object IsInherited).Count} | ConvertTo-Json -Compress'
    response = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
        env={**os.environ, 'DEP_TEST_PRIVATE': str(private)}, capture_output=True, text=True, check=True, timeout=15)
    info = json.loads(response.stdout)
    assert info == {'protected': True, 'rules': 1, 'inherited': 0}


def test_default_mode_is_non_mutating_and_reports_blockers(deployment, monkeypatch):
    d = deployment
    d.audit = lambda: {'go': False, 'saclReadFailures': 1}
    monkeypatch.setattr(m.os, 'name', 'nt')
    report = m.Deployment.preflight(d)
    assert not report['go']
    assert len(report['blockers']) == 3
    assert not d.actions
    assert not d.state.exists()
