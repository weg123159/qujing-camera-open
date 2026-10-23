#!/usr/bin/env python3
"""Build the offline Android release with official SDK tools; no Gradle/runtime downloads.

Requires Python 3.9+, JDK 17, Android platform 35 and build-tools 35.0.0.
Signing key/password files must stay outside the source repository.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / 'android'
NS = '{http://schemas.android.com/apk/res/android}'


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk', type=Path, default=os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT'))
    parser.add_argument('--jdk', type=Path, default=os.environ.get('JAVA_HOME'))
    parser.add_argument('--build-tools', default='35.0.0')
    parser.add_argument('--keystore', required=True, type=Path)
    parser.add_argument('--password-file', required=True, type=Path)
    parser.add_argument('--alias', default='qujing')
    parser.add_argument('--output', type=Path, default=ANDROID / 'build' / 'qujing-camera-0.6.0-release.apk')
    parser.add_argument('--allow-missing-offline-manifest', action='store_true', help='Development compilation only, not final delivery')
    args = parser.parse_args()
    if not args.sdk or not args.jdk:
        parser.error('--sdk and --jdk (or ANDROID_HOME/JAVA_HOME) are required')
    sdk, jdk = args.sdk.resolve(), args.jdk.resolve()
    tools = sdk / 'build-tools' / args.build_tools
    platform = sdk / 'platforms' / 'android-35' / 'android.jar'
    executable = '.exe' if os.name == 'nt' else ''
    batch = '.bat' if os.name == 'nt' else ''
    javac = jdk / 'bin' / ('javac' + executable)
    aapt = tools / ('aapt2' + executable)
    d8 = tools / ('d8' + batch)
    signer = tools / ('apksigner' + batch)
    align = tools / ('zipalign' + executable)
    for path in [platform, javac, aapt, d8, signer, align, args.keystore, args.password_file]:
        if not path.is_file():
            raise SystemExit(f'Required file missing: {path}')
    for private in [args.keystore.resolve(), args.password_file.resolve()]:
        if private == ROOT or ROOT in private.parents:
            raise SystemExit('Signing material must be outside the repository')
    manifest = ET.parse(ANDROID / 'AndroidManifest.xml').getroot()
    permissions = [p.get(NS + 'name') for p in manifest.findall('uses-permission')]
    if permissions != ['android.permission.CAMERA']:
        raise SystemExit('Offline APK permits CAMERA only; unexpected permission in manifest')
    if manifest.find('application').get(NS + 'debuggable') != 'false':
        raise SystemExit('Release must be non-debuggable')
    offline_path = ROOT / 'dist' / 'offline-manifest.json'
    if not offline_path.exists() and not args.allow_missing_offline_manifest:
        raise SystemExit('Generate the complete offline manifest before final packaging')
    if offline_path.exists():
        offline = json.loads(offline_path.read_text(encoding='utf-8'))
        declared = set()
        for entry in offline.get('assets', []):
            relative = Path(entry['url'])
            if relative.is_absolute() or '..' in relative.parts or entry['url'] in declared:
                raise SystemExit('Invalid or duplicate offline asset entry')
            declared.add(entry['url'])
            source = ROOT / 'dist' / relative
            if not source.is_file() or source.stat().st_size != entry['bytes'] or sha256(source) != entry['sha256']:
                raise SystemExit('Offline manifest stale or asset missing: ' + entry['url'])
        actual = {p.relative_to(ROOT / 'dist').as_posix() for p in (ROOT / 'dist').rglob('*')
                  if p.is_file() and p.relative_to(ROOT / 'dist').as_posix() not in ['sw.js', 'offline-manifest.json']}
        if declared != actual or len(declared) != offline.get('totalFiles'):
            raise SystemExit('Offline manifest does not describe the complete dist directory')
        worker_source = (ROOT / 'dist' / 'sw.js').read_bytes().decode('utf-8')
        if ("const OFFLINE_BUILD = '" + offline['version'] + "';") not in worker_source \
                or ("const OFFLINE_WORKER_SOURCE_HASH = '" + offline['workerHash'] + "';") not in worker_source:
            raise SystemExit('Offline worker build stamps do not match the manifest')
        # The manifest hashes normalized stamps to avoid a manifest <-> worker hash cycle.
        normalized_worker = re.sub(r"const OFFLINE_BUILD = '[^']+';",
                                   "const OFFLINE_BUILD = 'BUILD_PENDING';", worker_source, count=1)
        normalized_worker = re.sub(r"const OFFLINE_WORKER_SOURCE_HASH = '[^']+';",
                                   "const OFFLINE_WORKER_SOURCE_HASH = 'WORKER_PENDING';", normalized_worker, count=1)
        if hashlib.sha256(normalized_worker.encode('utf-8')).hexdigest() != offline.get('workerHash'):
            raise SystemExit('Offline worker changed after manifest generation')
    native_inputs = [ANDROID / 'AndroidManifest.xml', Path(__file__).resolve()]
    native_inputs += sorted((ANDROID / 'src').rglob('*.java'))
    native_inputs += sorted(p for p in (ANDROID / 'res').rglob('*') if p.is_file())
    native_snapshot = {p: sha256(p) for p in native_inputs}
    work = ANDROID / 'build' / 'manual'
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    for folder in ['classes', 'generated', 'dex', 'assets/www']:
        (work / folder).mkdir(parents=True)
    assets = []
    for source in sorted((ROOT / 'dist').rglob('*')):
        if source.is_symlink():
            raise SystemExit(f'Asset symlinks are not permitted: {source}')
        if not source.is_file():
            continue
        relative = source.relative_to(ROOT / 'dist')
        if any(part.startswith('.') for part in relative.parts) or relative.name.startswith('qa-'):
            raise SystemExit(f'Unexpected private/QA asset in dist: {relative}')
        target = work / 'assets' / 'www' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        assets.append({'path': relative.as_posix(), 'bytes': source.stat().st_size, 'sha256': sha256(source)})
    icon = ANDROID / 'res' / 'mipmap-xxxhdpi' / 'ic_launcher.png'
    if not icon.exists():
        raise SystemExit('Android launcher icon missing')
    environment = dict(os.environ)
    environment['JAVA_HOME'] = str(jdk)
    environment['PATH'] = str(jdk / 'bin') + os.pathsep + environment.get('PATH', '')
    logs = []

    def run(command):
        display = ('apksigner sign [private keystore arguments redacted]'
                   if len(command) > 1 and str(command[0]) == str(signer) and 'sign' in map(str, command)
                   else ' '.join(map(str, command)))
        print(display, flush=True)
        result = subprocess.run(list(map(str, command)), env=environment, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
        logs.append(display + '\n' + result.stdout)
        print(result.stdout, end='', flush=True)
        if result.returncode:
            (work / 'build.log').write_text('\n'.join(logs), encoding='utf-8')
            raise SystemExit(f'Build step failed with exit {result.returncode}')
        return result.stdout

    run([javac, '-version'])
    run([aapt, 'version'])
    resources = work / 'resources.zip'
    base = work / 'unsigned.apk'
    aligned = work / 'aligned.apk'
    run([aapt, 'compile', '--dir', ANDROID / 'res', '-o', resources])
    run([aapt, 'link', '-o', base, '--manifest', ANDROID / 'AndroidManifest.xml', '-I', platform,
         '--java', work / 'generated', '-R', resources, '-A', work / 'assets', '--auto-add-overlay'])
    sources = sorted((ANDROID / 'src').rglob('*.java')) + sorted((work / 'generated').rglob('*.java'))
    run([javac, '-encoding', 'UTF-8', '--release', '8', '-classpath', platform,
         '-d', work / 'classes', *sources])
    classes = sorted((work / 'classes').rglob('*.class'))
    run([d8, '--release', '--min-api', '26', '--lib', platform, '--output', work / 'dex', *classes])
    with zipfile.ZipFile(base, 'a', compression=zipfile.ZIP_DEFLATED) as apk:
        for dex in sorted((work / 'dex').glob('*.dex')):
            apk.write(dex, dex.name)
    run([align, '-f', '4', base, aligned])
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    run([signer, 'sign', '--ks', args.keystore.resolve(), '--ks-key-alias', args.alias,
         '--ks-pass', 'file:' + str(args.password_file.resolve()), '--out', output, aligned])
    run([signer, 'verify', '--verbose', output])
    run([align, '-c', '-v', '4', output])
    badging = run([aapt, 'dump', 'badging', output])
    permission_dump = run([aapt, 'dump', 'permissions', output])
    compiled_manifest = run([aapt, 'dump', 'xmltree', output, '--file', 'AndroidManifest.xml'])
    if 'android.permission.INTERNET' in permission_dump or "uses-permission: name='android.permission.CAMERA'" not in permission_dump:
        raise SystemExit('Packaged permission verification failed')
    if 'android:debuggable' not in compiled_manifest or 'android:debuggable(0x0101000f)=false' not in compiled_manifest:
        # aapt2 versions format false as 0x0; accept either explicit representation.
        debuggable = [line for line in compiled_manifest.splitlines() if 'android:debuggable' in line]
        if not debuggable or not any('false' in line or '0x0' in line for line in debuggable):
            raise SystemExit('Packaged non-debuggable verification failed')
    with zipfile.ZipFile(output) as apk:
        if 'classes.dex' not in apk.namelist():
            raise SystemExit('DEX file missing')
        for entry in assets:
            data = apk.read('assets/www/' + entry['path'])
            if hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise SystemExit('Packaged asset mismatch: ' + entry['path'])
    for entry in assets:
        if sha256(ROOT / 'dist' / entry['path']) != entry['sha256']:
            raise SystemExit('Source changed during packaging; rebuild after edits finish')
    for path, expected in native_snapshot.items():
        if sha256(path) != expected:
            raise SystemExit('Native source changed during packaging; rebuild after edits finish')
    report = {'package': 'cn.qujing.camera', 'version': '0.6.0', 'minSdk': 26, 'targetSdk': 35,
              'debuggable': False, 'permissions': permissions, 'internetPermission': False,
              'apk': output.name, 'bytes': output.stat().st_size, 'sha256': sha256(output),
              'signatureVerified': True, 'assets': assets,
              'nativeInputs': [{'path': p.relative_to(ROOT).as_posix(), 'sha256': h} for p, h in native_snapshot.items()],
              'physicalDeviceTest': 'NOT_RUN',
              'build': 'javac -> d8 -> aapt2 -> zipalign -> apksigner',
              'developmentBuild': args.allow_missing_offline_manifest}
    output.with_suffix('.build-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    output.with_suffix('.sha256').write_text(report['sha256'] + '  ' + output.name + '\n', encoding='utf-8')
    (work / 'build.log').write_text('\n'.join(logs), encoding='utf-8')
    print(json.dumps({k: report[k] for k in ['apk','bytes','sha256','permissions','internetPermission','debuggable']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
