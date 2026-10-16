"""Package only this companion's original code and documentation."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'module.json').read_text(encoding='utf-8'))
files = [root / name for name in ('module.json', 'README.md', 'CHANGELOG.md')]
for folder in ('scripts', 'styles'):
    files.extend(path for path in (root / folder).rglob('*') if path.is_file())
output = root / 'dist'
output.mkdir(exist_ok=True)
archive = output / f"{manifest['id']}-{manifest['version']}.zip"
with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
    for path in sorted(files):
        bundle.write(path, path.relative_to(root).as_posix())
with ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    assert json.loads(bundle.read('module.json')) == manifest
    for file in manifest['esmodules'] + manifest.get('styles', []):
        assert file in bundle.namelist()
print(archive)
