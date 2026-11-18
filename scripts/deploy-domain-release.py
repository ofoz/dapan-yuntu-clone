#!/usr/bin/env python3
"""在目标服务器以 root 运行；不含密码，不变更 1Panel 或证书配置。"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

ROOT = Path('/opt/dapan-cloud')
RELEASE = ROOT / 'releases/20261116-02'
IMAGE = 'dapan-cloud:20261116-02'
BUILD_ID = 'sgTFf5Db1RCKeD7SUEF54'
SITE_URL = 'https://dp.192163.xyz'
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def run(args, *, capture=False):
    return subprocess.run(args, cwd=ROOT, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def request(path):
    with OPENER.open('http://127.0.0.1:3000' + path, timeout=90) as response:
        assert response.status == 200
        return response.read().decode()


def write_env(content):
    temp = ROOT / '.env.dapan-release.tmp'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, ROOT / '.env')


def main():
    if os.geteuid() != 0:
        raise SystemExit('请在目标服务器以 root 或 sudo python3 运行。')
    if not ROOT.is_dir():
        raise SystemExit('未找到 /opt/dapan-cloud，当前机器不是预期目标。')
    lock = (ROOT / '.domain-release.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest = json.loads((RELEASE / 'manifest.json').read_text())
    assert manifest['siteUrl'] == SITE_URL and manifest['buildId'] == BUILD_ID
    verification = json.loads((RELEASE / 'verification.json').read_text())
    for name, expected in verification['files'].items():
        relative = Path(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        assert hashlib.sha256((RELEASE / relative).read_bytes()).hexdigest() == expected, name
    for name, expected in verification['links'].items():
        relative = Path(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        assert str((RELEASE / relative).readlink()) == expected, name
    print('发布文件与链接校验通过。', flush=True)
    run(['docker', 'build', '--tag', IMAGE, str(RELEASE)])
    built = run(['docker', 'run', '--rm', '--entrypoint', 'cat', IMAGE,
                 '/app/.next/BUILD_ID'], capture=True).strip()
    assert built == BUILD_ID, '镜像中的构建 ID 不匹配。'
    original = (ROOT / '.env').read_text()
    assert len(re.findall(r'^DAPAN_IMAGE=.+$', original, re.M)) == 1
    old_image = re.search(r'^DAPAN_IMAGE=(.+)$', original, re.M).group(1)
    replacement = re.sub(r'^DAPAN_IMAGE=.+$', 'DAPAN_IMAGE=' + IMAGE, original, flags=re.M)
    backups = ROOT / 'backups'
    backups.mkdir(exist_ok=True)
    name = 'env-before-domain-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    fd = os.open(backups / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(original)
    try:
        write_env(replacement)
        run(['docker', 'compose', 'up', '-d', '--wait', '--wait-timeout', '120'])
        container = run(['docker', 'compose', 'ps', '-q', 'dapan-cloud'], capture=True).strip()
        assert container
        running = run(['docker', 'exec', container, 'cat', '/app/.next/BUILD_ID'], capture=True).strip()
        assert running == BUILD_ID
        page = request('/features')
        assert 'rel="canonical" href="' + SITE_URL + '/features"' in page
        sitemap = request('/sitemap.xml')
        urls = re.findall(r'<loc>(.*?)</loc>', sitemap)
        assert urls and all(url == SITE_URL or url.startswith(SITE_URL + '/') for url in urls)
        status = json.loads(request('/api/heatmap/status'))
        quotes = json.loads(request('/api/heatmap/quotes?codes=600519.SH,000001.SZ&period=day'))
        assert quotes['source'] == 'direct'
        assert len(quotes['quotes']) == 2
        result = {'passed': True, 'image': IMAGE, 'buildId': running,
                  'siteUrl': SITE_URL, 'status': status,
                  'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        (ROOT / 'domain-release-verification.json').write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    except BaseException:
        write_env(original)
        run(['docker', 'compose', 'up', '-d', '--wait', '--wait-timeout', '120'])
        print('部署或验收失败，已恢复原镜像配置：' + old_image, flush=True)
        raise
    print('域名版发布成功，旧镜像保留。', flush=True)


if __name__ == '__main__':
    main()
