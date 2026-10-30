"""DEP-02, real git/tokenizer with synthetic data and actual MCP stdio.
Run with the installed venv Python. No production write or process control.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

DEPENDENCIES = ['src/__init__.py', 'src/constants.py', 'src/utils.py',
    'src/mcp_tools/__init__.py', 'src/mcp_tools/common.py', 'src/tools/__init__.py',
    'src/tools/context_compressor.py', 'src/tools/python_exec.py', 'src/tools/jvm_exec.py']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fixture_path(value):
    root = Path(value).resolve()
    if not root.is_relative_to(Path.cwd().resolve() / '.local'):
        raise ValueError('fixture must be inside cwd/.local')
    return root


def serve(root, expected):
    root = fixture_path(root)
    if not (root / '.deployment-fixture').is_file():
        raise ValueError('fixture marker missing')
    sys.path.insert(0, str(root))
    from src.mcp_tools import core
    from src.mcp_tools.common import create_mcp
    assert Path(core.__file__).resolve() == root / 'src/mcp_tools/core.py'
    assert sha(Path(core.__file__)) == expected
    core.MEMORY_DIR = root / 'data/persistent_memory'
    core.HISTORY_DIR = core.MEMORY_DIR / '.history'
    core.ARCHIVE_DIR = core.MEMORY_DIR / '.archive'
    core.ACCESS_FILE = core.MEMORY_DIR / '.access.json'
    core.GIT_LOG_FILE = core.MEMORY_DIR / '.gitlog.jsonl'
    core.MEMORY_MD_DIR = root / 'memory-md'
    # No replacement of _count_tokens_sync or _git_commit_store.
    mcp = create_mcp('DEP-02 isolated real dependencies')
    core.register_tools(mcp)
    mcp.run()


async def check(args, root):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'MCP_LOG_LEVEL': 'ERROR',
           'GIT_CONFIG_GLOBAL': str(root / 'empty-git-config'), 'GIT_CONFIG_NOSYSTEM': '1'}
    store = root / 'data/persistent_memory'
    store.mkdir(parents=True)
    (root / 'empty-git-config').write_text('', encoding='utf-8')
    def git(*command):
        return subprocess.run(['git', '-C', str(store), *command], env=env,
                              capture_output=True, text=True, check=True, timeout=15).stdout.strip()
    git('init')
    git('config', 'user.name', 'TaskBridge deployment smoke')
    git('config', 'user.email', 'smoke@example.invalid')
    for i in range(30):
        (store / f'fixture-{i}.md').write_text('synthetic fixture', encoding='utf-8')
    params = StdioServerParameters(command=sys.executable,
        args=['-B', str(Path(__file__).resolve()), '--serve', '--fixture', str(root),
              '--candidate-sha', args.candidate_sha], cwd=str(Path.cwd()), env=env)
    result = {'git': False, 'tokenizer': False, 'transport': False,
              'inventory': False, 'search': False, 'concurrency': False,
              'candidate_sha': args.candidate_sha, 'python': sys.executable,
              'prefix': sys.prefix, 'base_prefix': sys.base_prefix,
              'python_sha': sha(Path(sys.executable)),
              'pyvenv_cfg_sha': sha(Path(args.install_root) / '.venv/pyvenv.cfg'),
              'dependencies_sha': {rel: sha(root / rel) for rel in DEPENDENCIES},
              'git_executable': shutil.which('git'),
              'git_sha': sha(Path(shutil.which('git')))}
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize()
            tools = await session.list_tools()
            assert any(t.name == 'manage_project_memory' for t in tools.tools)
            result['transport'] = True
            async def call(action, **kw):
                response = await session.call_tool('manage_project_memory', {'action': action, **kw})
                assert not response.isError
                return json.loads(next(c.text for c in response.content if c.type == 'text'))
            first = await call('save', topic='deploysmoke', content='synthetic deployment first revision')
            assert first.get('status') == 'SAVED', first.get('error')
            result['tokenizer'] = isinstance(first.get('tokens'), int) and first['tokens'] > 0
            result['git'] = bool(re.fullmatch('[0-9a-f]{7,40}', first.get('git_commit', '')))
            assert git('rev-parse', 'HEAD').startswith(first['git_commit'])
            result['inventory'] = first['storage']['active_topics'] == 31
            before = (store / 'deploysmoke.md').read_bytes()
            second = await call('save', topic='deploysmoke', content='synthetic deployment second revision')
            assert second.get('status') == 'SAVED'
            assert (store / second['backup']).read_bytes() == before
            found = await call('search', query='synthetic deployment second revision')
            result['search'] = found.get('hit_count', 0) > 0
            versions = await call('history', topic='deploysmoke')
            assert versions['snapshot_count'] >= 1
            replies = await asyncio.gather(*[
                call('save', topic='deploysmoke', content=f'synthetic concurrent revision {i}')
                for i in range(2)])
            statuses = [r.get('status') or r.get('error', {}).get('code') for r in replies]
            result['concurrency'] = 'SAVED' in statuses and all(s in ('SAVED', 'MEMORY_CONFLICT') for s in statuses)
            result['git_commits'] = int(git('rev-list', '--count', 'HEAD'))
    result['go'] = all(result[k] for k in ('git', 'tokenizer', 'transport', 'inventory', 'search', 'concurrency'))
    (root / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
    return 0 if result['go'] else 2


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--fixture', required=True)
    p.add_argument('--candidate-sha', required=True)
    p.add_argument('--candidate')
    p.add_argument('--install-root')
    p.add_argument('--serve', action='store_true', help=argparse.SUPPRESS)
    args = p.parse_args()
    root = fixture_path(args.fixture)
    if args.serve:
        serve(root, args.candidate_sha)
        return 0
    if not args.candidate or not args.install_root:
        p.error('--candidate and --install-root required')
    candidate = Path(args.candidate).resolve()
    if sha(candidate) != args.candidate_sha:
        raise ValueError('candidate SHA mismatch')
    root.mkdir(parents=True, exist_ok=False)
    (root / '.deployment-fixture').write_text('synthetic data only', encoding='utf-8')
    source = Path(args.install_root).resolve()
    for rel in DEPENDENCIES:
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((source / rel).read_bytes())
    (root / 'src/mcp_tools/core.py').write_bytes(candidate.read_bytes())
    return asyncio.run(check(args, root))


if __name__ == '__main__':
    raise SystemExit(main())
