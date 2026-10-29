"""Run with python -m pytest tests/test_legacy_memory_persistence.py.
Only AST-selected functions run; MCP imports, tokenizer, git and real store never run.
"""
import ast
import asyncio
import contextlib
import datetime
import errno
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import re
import sys
import uuid

import pytest

SOURCE = Path(os.environ.get('TASKBRIDGE_LEGACY_MEMORY_SOURCE',
    str(Path(__file__).resolve().parents[1] / '.local' / 'mem01b' / 'core.py')))
if not SOURCE.is_file():
    pytest.skip('isolated MCP source not prepared; set TASKBRIDGE_LEGACY_MEMORY_SOURCE', allow_module_level=True)


def load(root, source=SOURCE):
    tree = ast.parse(source.read_text(encoding='utf-8'))
    funcs = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
    # Future annotations avoid evaluating tool schema dependencies.
    tree = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0), *funcs], type_ignores=[])
    ns = dict(asyncio=asyncio, contextlib=contextlib, datetime=datetime, hashlib=hashlib,
              json=json, os=os, Path=Path, re=re, sys=sys, uuid=uuid, time=__import__('time'),
              MEMORY_DIR=root, HISTORY_DIR=root/'.history', ARCHIVE_DIR=root/'.archive',
              HISTORY_KEEP=5, MAX_ACTIVE_PROJECTS=15, MAX_MEMORY_TOKENS_LIMIT=2000,
              MAX_MEMORY_FILE_BYTES=256*1024)
    exec(compile(ast.fix_missing_locations(tree), str(source), 'exec'), ns)
    ns['_count_tokens_sync'] = lambda text: (len(text.split()), None)
    ns['_git_commit_store'] = lambda *args: ''
    return ns


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None


def save(ns, text='new'):
    return json.loads(asyncio.run(ns['manage_project_memory']('save', topic='fixture', content=text)))


@pytest.fixture
def store(tmp_path):
    p = tmp_path/'fixture.md'
    p.write_text('original', encoding='utf-8')
    return tmp_path, p, load(tmp_path)


def test_backup_failure_must_not_overwrite(store):
    root, p, ns = store
    old = digest(p)
    ns['_backup_topic'] = lambda *args, **kwargs: None
    result = save(ns)
    assert digest(p) == old
    assert result['error']['code'] == 'MEMORY_WRITE_FAILED'


def test_failed_write_must_not_prune_history(store, monkeypatch):
    root, p, ns = store
    directory = root/'.history'/'fixture'
    directory.mkdir(parents=True)
    for i in range(5): (directory/f'old-{i}.md').write_text(str(i))
    before = {f.name: digest(f) for f in directory.iterdir()}
    old_write = Path.write_text
    def fail_note(self, *args, **kwargs):
        if self == p: raise OSError(errno.ENOSPC, 'synthetic disk full')
        return old_write(self, *args, **kwargs)
    # Baseline writes the target directly; fixed implementation fails its temp write.
    if '_write_durable' in ns:
        original = ns['_write_durable']
        def fail_temp(target, data, **kwargs):
            if target.parent == root: raise OSError(errno.ENOSPC, 'synthetic disk full')
            return original(target, data, **kwargs)
        ns['_write_durable'] = fail_temp
    else:
        monkeypatch.setattr(Path, 'write_text', fail_note)
    try: result = save(ns)
    except OSError: result = None
    assert all((directory/f).exists() and digest(directory/f) == h for f, h in before.items())
    assert p.read_text() == 'original'
    assert result and result['error']['code'] == 'MEMORY_WRITE_FAILED'


def test_replace_failure_keeps_original(store, monkeypatch):
    root, p, ns = store
    original = os.replace
    def fail(src, dst):
        if Path(dst) == p: raise PermissionError(errno.EACCES, 'synthetic Windows sharing violation')
        return original(src, dst)
    monkeypatch.setattr(os, 'replace', fail)
    old = digest(p)
    result = save(ns)
    assert digest(p) == old
    assert result['error']['code'] == 'MEMORY_WRITE_FAILED'


def test_concurrent_version_change_is_not_lost(store):
    root, p, ns = store
    def tokenize(text):
        p.write_text('concurrent update')
        return (1, None)
    ns['_count_tokens_sync'] = tokenize
    result = save(ns)
    assert p.read_text() == 'concurrent update'
    assert result['error']['code'] == 'MEMORY_CONFLICT'


def test_success_retains_verified_backup(store):
    root, p, ns = store
    old = p.read_bytes()
    result = save(ns)
    assert result['status'] == 'SAVED'
    assert (root/result['backup']).read_bytes() == old
    assert b'new' in p.read_bytes()


@pytest.mark.parametrize('failure', ['disk-full', 'partial-write', 'fsync'])
def test_storage_failures_keep_original_sha(store, monkeypatch, failure):
    root, p, ns = store
    before = digest(p)
    original = ns['_write_durable']
    if failure == 'fsync':
        def fail_fsync(fd): raise OSError(errno.EIO, 'synthetic fsync failure')
        monkeypatch.setattr(os, 'fsync', fail_fsync)
    else:
        def fail_temp(target, data, **kwargs):
            if target.parent == root:
                if failure == 'partial-write': target.write_bytes(data[:3])
                raise OSError(errno.ENOSPC, 'synthetic disk full')
            return original(target, data, **kwargs)
        ns['_write_durable'] = fail_temp
    result = save(ns)
    assert result['error']['code'] == 'MEMORY_WRITE_FAILED'
    assert digest(p) == before


def test_corrupt_backup_blocks_replace(store):
    root, p, ns = store
    before = digest(p)
    original = ns['_backup_topic']
    def corrupt(*args):
        rel = original(*args)
        (root/rel).write_bytes(b'corrupt fixture')
        return rel
    ns['_backup_topic'] = corrupt
    assert save(ns)['error']['code'] == 'MEMORY_WRITE_FAILED'
    assert digest(p) == before


def test_failed_commit_bookkeeping_reports_uncertainty(store):
    root, p, ns = store
    original = ns['_write_journal']
    def fail(topic, record):
        if record['state'] == 'committed': raise OSError('synthetic journal failure')
        return original(topic, record)
    ns['_write_journal'] = fail
    result = save(ns)
    assert result['error']['code'] == 'MEMORY_COMMIT_UNCERTAIN'
    assert b'new' in p.read_bytes()
    ns['_write_journal'] = original
    with ns['_topic_lock']('fixture'):
        assert ns['_recover_topic']('fixture', p)['state'] == 'committed'


def competing_worker(root, source, expected, ready, go, output):
    ns = load(Path(root), Path(source))
    ready.put(True)
    go.wait(15)
    try:
        ns['_persist_topic']('fixture', Path(root)/'fixture.md', str(os.getpid()).encode(), expected)
        output.put('saved')
    except ns['MemoryConflict']:
        output.put('conflict')


def test_two_processes_cannot_both_overwrite_same_version(store):
    root, p, ns = store
    ctx = multiprocessing.get_context('spawn')
    ready, out, go = ctx.Queue(), ctx.Queue(), ctx.Event()
    jobs = [ctx.Process(target=competing_worker, args=(str(root), str(SOURCE), digest(p), ready, go, out)) for _ in range(2)]
    try:
        for job in jobs: job.start()
        for _ in jobs: ready.get(timeout=20)
        go.set()
        assert sorted(out.get(timeout=20) for _ in jobs) == ['conflict', 'saved']
        for job in jobs:
            job.join(15)
            assert job.exitcode == 0
        assert any(f.read_bytes() == b'original' for f in (root/'.history'/'fixture').glob('*.md'))
    finally:
        for job in jobs:
            if job.is_alive(): job.terminate()
            job.join(10)
        ready.close(); out.close()


def crash_worker(root, source, phase):
    root = Path(root)
    ns = load(root, Path(source))
    if phase == 'before-replace':
        replace = os.replace
        def crash(src, dst):
            if Path(dst) == root/'fixture.md': os._exit(73)
            return replace(src, dst)
        os.replace = crash
    else:
        journal = ns['_write_journal']
        def crash(topic, record):
            if record['state'] == 'committed': os._exit(73)
            return journal(topic, record)
        ns['_write_journal'] = crash
    ns['_persist_topic']('fixture', root/'fixture.md', b'replacement', digest(root/'fixture.md'))


@pytest.mark.parametrize('phase,state', [('before-replace', 'aborted'), ('after-replace', 'committed')])
def test_process_crash_is_recoverable_without_replaying_unknown_data(store, phase, state):
    root, p, ns = store
    before = digest(p)
    ctx = multiprocessing.get_context('spawn')
    child = ctx.Process(target=crash_worker, args=(str(root), str(SOURCE), phase))
    child.start()
    try:
        child.join(20)
        assert child.exitcode == 73
        if phase == 'before-replace': assert digest(p) == before
        else: assert p.read_bytes() == b'replacement'
        with ns['_topic_lock']('fixture'):
            record = ns['_recover_topic']('fixture', p)
        assert record['state'] == state
        assert (root/record['backup']).read_bytes() == b'original'
        # Lock was released by OS despite abrupt process exit; subsequent save works.
        assert save(ns)['status'] == 'SAVED'
    finally:
        if child.is_alive(): child.terminate()
        child.join(10)


def test_recovery_never_overwrites_unknown_version(store):
    root, p, ns = store
    assert save(ns)['status'] == 'SAVED'
    journal = ns['_journal_path']('fixture')
    record = json.loads(journal.read_text())
    record['state'] = 'prepared'
    journal.write_text(json.dumps(record))
    p.write_bytes(b'unknown external update')
    before = digest(p)
    with pytest.raises(ns['MemoryConflict']):
        with ns['_topic_lock']('fixture'): ns['_recover_topic']('fixture', p)
    assert digest(p) == before


@pytest.mark.parametrize('count', [15, 16, 30, 1000])
def test_topic_count_is_not_overflow(store, count):
    root, p, ns = store
    for i in range(count-1): (root/f'note-{i}.md').write_text('fixture')
    archived = root/'.archive'
    archived.mkdir()
    (archived/'archived.md').write_text('archive')
    result = save(ns)
    assert result['status'] == 'SAVED'
    assert 'warning' not in result
    assert len(list(root.glob('*.md'))) == count
    assert result['storage']['active_topics'] == count
    assert result['storage']['archived_files'] == 1
    assert result['storage']['per_file_token_limit'] == 2000


@pytest.mark.parametrize('kind', ['tokens', 'bytes'])
def test_per_file_limits_preserve_original(store, kind):
    root, p, ns = store
    before = digest(p)
    content = ('x ' * 2001) if kind == 'tokens' else ('x' * (256*1024+1))
    result = save(ns, content)
    assert result['error']['code'] == 'MEMORY_TOO_LARGE'
    assert digest(p) == before


def test_readonly_replace_error_never_unlinks_original(store, monkeypatch):
    root, p, ns = store
    before = digest(p)
    replace = os.replace
    def denied(src, dst):
        if Path(dst) == p: raise PermissionError('synthetic permission denial')
        return replace(src, dst)
    monkeypatch.setattr(os, 'replace', denied)
    assert save(ns)['error']['code'] == 'MEMORY_WRITE_FAILED'
    assert digest(p) == before


def test_history_retention_only_after_verified_commit(store):
    root, p, ns = store
    for i in range(8):
        result = save(ns, str(i))
        assert result['status'] == 'SAVED'
        assert (root/result['backup']).is_file()
        assert len(list((root/'.history'/'fixture').glob('*.md'))) <= 5


def test_new_topic_failure_does_not_create_partial_markdown(tmp_path):
    ns = load(tmp_path)
    original = ns['_write_durable']
    def full(target, data, **kwargs):
        if target.parent == tmp_path:
            target.write_bytes(data[:2])
            raise OSError(errno.ENOSPC, 'synthetic disk full')
        return original(target, data, **kwargs)
    ns['_write_durable'] = full
    result = save(ns)
    assert result['error']['code'] == 'MEMORY_WRITE_FAILED'
    assert not (tmp_path/'fixture.md').exists()


@pytest.mark.parametrize('action', ['delete', 'archive', 'restore'])
def test_all_mutations_share_save_lock(store, monkeypatch, action):
    root, p, ns = store
    replacement = os.replace
    results = []
    def interleave(src, dst):
        if Path(dst) == p:
            response = asyncio.run(ns['manage_project_memory'](action, topic='fixture', version='synthetic'))
            results.append(json.loads(response))
        return replacement(src, dst)
    monkeypatch.setattr(os, 'replace', interleave)
    assert save(ns)['status'] == 'SAVED'
    assert results[0]['error']['code'] == 'MEMORY_CONFLICT'
    assert b'new' in p.read_bytes()


def test_version_restore_uses_verified_atomic_write(store, monkeypatch):
    root, p, ns = store
    saved = save(ns)
    version = Path(saved['backup']).stem
    before = digest(p)
    replace = os.replace
    def denied(src, dst):
        if Path(dst) == p: raise PermissionError('synthetic locked Windows target')
        return replace(src, dst)
    monkeypatch.setattr(os, 'replace', denied)
    result = json.loads(asyncio.run(ns['manage_project_memory']('restore', topic='fixture', version=version)))
    assert result['error']['code'] == 'MEMORY_WRITE_FAILED'
    assert digest(p) == before
    monkeypatch.setattr(os, 'replace', replace)
    result = json.loads(asyncio.run(ns['manage_project_memory']('restore', topic='fixture', version=version)))
    assert result['status'] == 'RESTORED'
    assert p.read_bytes() == b'original'


def test_archive_and_restore_preserve_bytes_without_colliding_names(store):
    root, p, ns = store
    for i in range(2):
        p.write_bytes(f'fixture-{i}'.encode())
        result = json.loads(asyncio.run(ns['manage_project_memory']('archive', topic='fixture')))
        assert result['status'] == 'ARCHIVED'
        assert not p.exists()
    assert len(list((root/'.archive').glob('*.md'))) == 2
    result = json.loads(asyncio.run(ns['manage_project_memory']('restore', topic='fixture')))
    assert result['status'] == 'RESTORED'
    assert p.read_bytes() == b'fixture-1'


def test_oversized_bytes_never_reach_tokenizer(store):
    root, p, ns = store
    def forbidden(text): raise AssertionError('oversized input reached tokenizer')
    ns['_count_tokens_sync'] = forbidden
    assert save(ns, 'x'*(256*1024+1))['error']['code'] == 'MEMORY_TOO_LARGE'


@pytest.mark.skipif(os.name != 'nt', reason='Windows sharing semantics')
def test_native_windows_sharing_violation_preserves_original(store):
    import ctypes
    from ctypes import wintypes
    root, p, ns = store
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    # Existing file opened for reading, sharing read/write but NOT deletion.
    handle = create(str(p), 0x80000000, 0x1 | 0x2, None, 3, 0x80, None)
    assert handle != ctypes.c_void_p(-1).value, ctypes.get_last_error()
    before = digest(p)
    try:
        result = save(ns)
        assert result['error']['code'] == 'MEMORY_WRITE_FAILED'
        assert digest(p) == before
    finally:
        assert close(handle)
    assert save(ns)['status'] == 'SAVED'


@pytest.mark.skipif(os.name != 'nt', reason='NTFS security descriptors')
def test_protected_ntfs_acl_is_preserved(store):
    import subprocess
    root, p, ns = store
    script = '''
$p = $env:TASKBRIDGE_ACL_FIXTURE
$acl = Get-Acl -LiteralPath $p
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    [System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
(Get-Acl -LiteralPath $p).Sddl
'''
    env = {**os.environ, 'TASKBRIDGE_ACL_FIXTURE': str(p)}
    before = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                            env=env, capture_output=True, text=True, check=True).stdout.strip()
    assert before, 'expected security descriptor'
    assert save(ns)['status'] == 'SAVED'
    after = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                            '(Get-Acl -LiteralPath $env:TASKBRIDGE_ACL_FIXTURE).Sddl'],
                           env=env, capture_output=True, text=True, check=True).stdout.strip()
    # Windows may clear the informational AUTO_INHERITED bit when copying a
    # protected DACL. Owner/group, protected flag and ACEs must remain identical.
    assert 'D:P' in before and 'D:P' in after
    assert after.replace('D:PAI', 'D:P') == before.replace('D:PAI', 'D:P'), 'saving changed protected permissions'


def test_security_applied_before_any_backup_or_temp_content(store):
    root, p, ns = store
    original = ns['_copy_file_security']
    seen = []
    def verify(source, target):
        assert target.read_bytes() == b'', 'private bytes written before permissions'
        seen.append(target)
        return original(source, target)
    ns['_copy_file_security'] = verify
    assert save(ns)['status'] == 'SAVED'
    assert len(seen) == 2, 'verified backup and replacement temp both need protection'


def test_security_failure_preserves_original(store):
    root, p, ns = store
    before = digest(p)
    def deny(*args): raise PermissionError('synthetic security-copy denial')
    ns['_copy_file_security'] = deny
    assert save(ns)['error']['code'] == 'MEMORY_WRITE_FAILED'
    assert digest(p) == before


@pytest.mark.skipif(os.name != 'nt', reason='Windows file attributes')
def test_readonly_original_is_refused_without_attribute_loss(store):
    import stat
    root, p, ns = store
    before = digest(p)
    os.chmod(p, stat.S_IREAD)
    try:
        assert save(ns)['error']['code'] == 'MEMORY_WRITE_FAILED'
        assert digest(p) == before
        assert not (p.stat().st_mode & stat.S_IWRITE)
    finally:
        os.chmod(p, stat.S_IREAD | stat.S_IWRITE)


def test_cleanup_failure_is_saved_with_diagnostic(store):
    root, p, ns = store
    def fail(*args): raise PermissionError('synthetic retention permission error')
    ns['_prune_topic_history'] = fail
    result = save(ns)
    assert result['status'] == 'SAVED'
    assert 'PermissionError' in result['cleanup_warning']
    assert (root/result['backup']).read_bytes() == b'original'
