#!/usr/bin/env python3
"""Render a deployment-owned Compose file and Router catalog, without secrets."""
import argparse
import json
import re
import tempfile
from pathlib import Path


def setting(path, name, default, maximum):
    # These deployment controls are deliberately integer literals, not shell
    # expressions. Other dotenv values (including credentials) are never read
    # into generated output. Accept Compose's quoted literals and comments.
    entries = [line.split('=', 1)[1].strip() for line in path.read_text().splitlines()
               if re.match(r'^\s*' + name + r'\s*=', line)]
    if not entries:
        return default
    if len(entries) != 1:
        raise ValueError(name + ' must be defined once')
    match = re.fullmatch(r'''(?:([0-9]+)|'([0-9]+)'|"([0-9]+)")(?:\s+#.*)?''', entries[0])
    if not match:
        raise ValueError(name + ' must be a positive integer literal')
    value = int(next(group for group in match.groups() if group is not None))
    if not 1 <= value <= maximum:
        raise ValueError(name + ' must be between 1 and ' + str(maximum))
    return value


def render(template_dir, root, env_file):
    count = setting(env_file, 'RUNTIME_COUNT', 2, 256)
    capacity = setting(env_file, 'MAX_CONCURRENT_RUNS', 20, 3600000)
    prototype = (template_dir / 'runtime-host.yaml').read_text()
    template = (template_dir / 'compose.yaml').read_text()
    for marker in ['  # RUNTIME_SERVICES', '  # RUNTIME_VOLUMES', '__TOPOLOGY_DIRECTORY__']:
        if template.count(marker) != 1:
            raise ValueError('invalid topology template marker: ' + marker)
    services, volumes, runtimes = [], [], []
    names = []
    for number in range(1, count + 1):
        suffix = format(number, '02d')
        name = 'runtime-general-' + suffix
        port = 8790 + number
        services.append(prototype.replace('__SUFFIX__', suffix).replace('__PORT__', str(port)).replace('__MAX_CONCURRENT_RUNS__', str(capacity)))
        volumes.append('  ' + name + '-data: {}')
        names.append(name)
        runtimes.append(dict(id='general-' + suffix, endpoint='http://' + name + ':' + str(port),
                             profile='general', capabilities=['document'], maxConcurrentRuns=capacity))
    directory = root / 'deployments'
    directory.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='topology-', dir=str(directory))).resolve()
    # Generated files contain paths and topology only, not interpolated env.
    # Container users must be able to read the bind-mounted catalog.
    output.chmod(0o755)
    compose = template.replace('  # RUNTIME_SERVICES', ''.join(services).rstrip())
    compose = compose.replace('  # RUNTIME_VOLUMES', '\n'.join(volumes))
    # YAML quoted scalar protects host paths containing punctuation/spaces.
    mount = json.dumps(str(output / 'runtimes.json') + ':/run/topology/runtimes.json:ro')
    compose = compose.replace('__TOPOLOGY_DIRECTORY__/runtimes.json:/run/topology/runtimes.json:ro', mount)
    files = {
        'compose.yaml': compose,
        'runtimes.json': json.dumps(dict(schema='agentloop.multiRuntimeConfig/v1', runtimes=runtimes), indent=2) + '\n',
        'topology.json': json.dumps(dict(schema='agentloop.deploymentTopology/v1', runtimeCount=count,
                                         runtimeServices=names, templateDirectory=str(template_dir.resolve())), indent=2) + '\n',
    }
    for name, content in files.items():
        path = output / name
        path.write_text(content)
        path.chmod(0o644)
    return output / 'compose.yaml'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--env-file', required=True, type=Path)
    args = parser.parse_args()
    try:
        print(render(Path(__file__).resolve().parent, args.root, args.env_file))
    except (ValueError, OSError) as error:
        parser.exit(1, 'Topology error: ' + str(error) + '\n')
