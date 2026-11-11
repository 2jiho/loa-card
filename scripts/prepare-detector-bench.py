"""Create lossless local detector inputs from explicitly chosen video frames."""
import argparse
import hashlib
import json
import math
import pathlib
import re
import subprocess


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def command(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, help='new output directory')
    parser.add_argument('--source', nargs=3, action='append', required=True,
                        metavar=('LABEL', 'VIDEO', 'FRAME_INDICES'),
                        help='repeat for each video; frame indices are comma-separated and zero-based')
    args = parser.parse_args()
    if len(args.source) > 16:
        parser.error('select at most 16 video sources')
    labels = set()
    selections = []
    for label, filename, indexes in args.source:
        if not re.fullmatch(r'[a-zA-Z0-9_-]{1,40}', label) or label in labels:
            parser.error('source labels must be unique and contain only letters, numbers, underscores or hyphens')
        labels.add(label)
        if not re.fullmatch(r'\d+(,\d+)*', indexes):
            parser.error('frame indices must be comma-separated nonnegative integers')
        numbers = [int(value) for value in indexes.split(',')]
        if len(numbers) > 1000 or numbers != sorted(set(numbers)):
            parser.error('select at most 1000 unique frame indices in increasing order')
        source = pathlib.Path(filename)
        if not source.is_file():
            parser.error(f'source is not a file: {filename}')
        selections.append((label, source, numbers))

    root = pathlib.Path(args.output)
    root.mkdir(parents=True, exist_ok=False)
    sources = []
    for label, path, indices in selections:
        source_sha256, source_bytes = digest(path), path.stat().st_size
        raw = command(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames', '-show_entries',
                       'frame=best_effort_timestamp_time', '-of', 'json', str(path)])
        times = json.loads(raw)['frames']
        if indices[-1] >= len(times):
            raise ValueError(f'{label} has too few frames')
        output = root / label
        output.mkdir()
        expression = '+'.join('eq(n\\,%d)' % index for index in indices)
        command(['ffmpeg', '-v', 'error', '-i', str(path), '-map', '0:v:0', '-vf', f'select={expression}',
                 '-fps_mode', 'passthrough', '-start_number', '0', str(output / '%03d.png')])
        entries = []
        for position, index in enumerate(indices):
            image = output / f'{position:03}.png'
            timestamp = times[index].get('best_effort_timestamp_time')
            if timestamp is None:
                raise ValueError(f'{label} frame {index} is missing a presentation timestamp')
            timestamp = float(timestamp)
            if not math.isfinite(timestamp):
                raise ValueError(f'{label} frame {index} has a non-finite presentation timestamp')
            entries.append({'ordinal': index, 'presentationTimeSeconds': timestamp,
                            'file': f'{label}/{position:03}.png', 'bytes': image.stat().st_size,
                            'pngSha256': digest(image)})
        if path.stat().st_size != source_bytes or digest(path) != source_sha256:
            raise ValueError(f'{label} changed during extraction')
        sources.append({'label': label, 'sourceSha256': source_sha256, 'sourceBytes': source_bytes,
                        'ffprobeFrameCount': len(times), 'frames': entries})

    manifest = {'version': 1, 'basis': 'ffprobe presentation timestamps and ffmpeg decoded PNG, not historical live captures',
                'ffmpegVersion': command(['ffmpeg', '-version']).decode(errors='replace').splitlines()[0],
                'ffprobeVersion': command(['ffprobe', '-version']).decode(errors='replace').splitlines()[0],
                'sources': sources}
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    print(json.dumps({'sources': len(sources), 'frames': sum(len(source['frames']) for source in sources)}))


if __name__ == '__main__':
    main()
