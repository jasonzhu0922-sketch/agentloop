/** Metadata inspection only: never imports a Skill or executes its setup files. */
export const SKILL_PYTHON_PROBE = String.raw`
import importlib.metadata as metadata
import json, pathlib, sys
from packaging.requirements import Requirement
from packaging.specifiers import SpecifierSet
from packaging.utils import canonicalize_name

request = json.load(sys.stdin)
rows = []
install = []
expanded = set()
def row(label, status, detail, origin, installable=False):
    rows.append(dict(kind='python', label=label, status=status, detail=detail, origin=origin, installable=installable))
def check(text, origin, root=False, extra=''):
    try:
        req = Requirement(text)
        if req.url:
            row(text, 'manual', 'URL and local-project dependencies require manual preparation.', origin)
            return
        if req.marker and not req.marker.evaluate({'extra': extra}):
            if root: row(text, 'skipped', 'Not required on this Python/platform.', origin)
            return
        if root: install.append(str(req))
        try:
            dist = metadata.distribution(req.name)
        except metadata.PackageNotFoundError:
            row(text, 'missing', 'Python distribution is not installed.', origin, root)
            return
        if not req.specifier.contains(dist.version, prereleases=True):
            row(text, 'incompatible', 'Installed version: ' + dist.version, origin, root)
            return
        extras = {canonicalize_name(x) for x in req.extras}
        available = {canonicalize_name(x) for x in dist.metadata.get_all('Provides-Extra', [])}
        if extras - available:
            row(text, 'incompatible', 'Distribution does not provide requested extras.', origin)
            return
        key = (canonicalize_name(req.name), tuple(sorted(extras)))
        row(text, 'satisfied', 'Installed version: ' + dist.version, origin)
        if key in expanded: return
        expanded.add(key)
        if len(expanded) > 512: raise ValueError('dependency graph exceeds 512 selections')
        for child_text in dist.requires or []:
            child = Requirement(child_text)
            if child.marker and not any(child.marker.evaluate({'extra': x}) for x in ['', *extras]): continue
            child.marker = None
            check(str(child), str(req))
    except Exception as error:
        row(text, 'unknown', 'Invalid requirement or metadata: ' + type(error).__name__, origin)

for version in request.get('versions', []):
    try:
        ok = SpecifierSet(version['text']).contains('.'.join(map(str, sys.version_info[:3])), prereleases=True)
        row('Python ' + version['text'], 'satisfied' if ok else 'incompatible', sys.version.split()[0], version['origin'])
    except Exception:
        row('Python ' + version['text'], 'unknown', 'Invalid Python version range.', version['origin'])
for entry in request.get('entries', []): check(entry['text'], entry['origin'], True)
print(json.dumps(dict(version=sys.version.split()[0], rows=rows, install=list(dict.fromkeys(install)))))
`;
