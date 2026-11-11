import { spawnSync } from 'node:child_process';

// Validate the installed prefix after pruning, without pip or host packages.
// Imports alone cannot detect missing extras, incompatible versions or a
// dependency that was accidentally resolved from the build machine.
export const packagedPythonRequirementsProbe = `
import importlib.metadata as metadata
import pathlib
import sys
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

requirements = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]).resolve()
pending = []
for number, line in enumerate(requirements.read_text().splitlines(), 1):
    line = line.split(' #', 1)[0].strip()
    if line and not line.startswith('#'):
        pending.append((line, f'{requirements.name}:{number}'))
expanded = set()
while pending:
    text, owner = pending.pop()
    requirement = Requirement(text)
    if requirement.marker and not requirement.marker.evaluate({'extra': ''}):
        continue
    if requirement.url:
        raise RuntimeError(f'{owner}: URL requirements cannot be verified: {text}')
    try:
        distribution = metadata.distribution(requirement.name)
    except metadata.PackageNotFoundError:
        raise RuntimeError(f'{owner}: missing packaged dependency {text}') from None
    location = pathlib.Path(distribution.locate_file('')).resolve()
    if not location.is_relative_to(root):
        raise RuntimeError(f'{owner}: dependency {requirement.name} resolved outside packaged Python: {location}')
    if not requirement.specifier.contains(distribution.version, prereleases=True):
        raise RuntimeError(f'{owner}: {text} requires a different version; packaged {distribution.version}')
    extras = {canonicalize_name(extra) for extra in requirement.extras}
    available = {canonicalize_name(extra) for extra in distribution.metadata.get_all('Provides-Extra', [])}
    if extras - available:
        raise RuntimeError(f'{owner}: {requirement.name} has no extras {sorted(extras - available)}')
    key = (canonicalize_name(requirement.name), tuple(sorted(extras)))
    if key in expanded:
        continue
    expanded.add(key)
    for dependency in distribution.requires or []:
        child = Requirement(dependency)
        if child.marker and not any(child.marker.evaluate({'extra': extra}) for extra in ['', *extras]):
            continue
        child.marker = None
        pending.append((str(child), str(requirement)))
print(f'Packaged Python requirements verified: {len(expanded)} dependency selections')
`;

export function verifyPackagedPythonRequirements(python, requirementsPath, root) {
  const result = spawnSync(python, ['-I', '-B', '-c', packagedPythonRequirementsProbe, requirementsPath, root], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONHOME: '', PYTHONPATH: '', PYTHONUSERBASE: '', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 30000,
  });
  if (result.status !== 0) throw new Error(`Packaged Python requirements validation failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return result.stdout.trim();
}
