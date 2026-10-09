"""Exercise the pinned TUI with an actual PTY and the smoke fixture's hung model."""
import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import sys
import termios
import time
import urllib.request

binary, server, directory, output = sys.argv[1:]
root = Path(output)
auth = 'Basic ' + base64.b64encode(('opencode:' + os.environ['OPENCODE_PASSWORD']).encode()).decode()


def api(path, body=None):
    request = urllib.request.Request(server + path, data=None if body is None else json.dumps(body).encode(),
                                    headers={'Authorization': auth, 'Content-Type': 'application/json',
                                             'x-opencode-directory': directory})
    with urllib.request.urlopen(request, timeout=10) as response:
        data = response.read()
        return json.loads(data) if data else None


for existing in [False, True]:
    label = 'existing' if existing else 'new'
    before = {item['id'] for item in api('/api/session')['data']}
    origin = api('/api/session', {'title': 'TUI existing origin', 'location': {'directory': directory}})['data']['id'] if existing else None
    prompt = '/pr-review https://dev.azure.com/fixture/project/_git/repository/pullrequest/123 hang-smoke'
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(directory)
        env = {**os.environ, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'}
        args = [binary, '--server', server, '--prompt', prompt] + (['--session', origin] if origin else [])
        os.execvpe(binary, args, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 160, 0, 0))
    captured = bytearray()
    started_at = None
    stop_sent = False
    stop_confirmed = False
    cancelled = False
    hold = float(os.environ.get('AZPR_TUI_HOLD_SECONDS', '2')) if not existing else 2
    deadline = time.monotonic() + hold + 50
    next_poll = 0
    try:
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.1)[0]:
                chunk = os.read(fd, 65536)
                captured.extend(chunk)
                if b'\x1b[6n' in chunk:
                    os.write(fd, b'\x1b[1;1R')
                if b'\x1b[c' in chunk:
                    os.write(fd, b'\x1b[?1;2c')
            if time.monotonic() < next_poll:
                continue
            next_poll = time.monotonic() + 0.25
            if not origin:
                candidates = [item for item in api('/api/session')['data'] if item['id'] not in before and not item.get('parentID')]
                if len(candidates) == 1:
                    origin = candidates[0]['id']
            if not origin:
                continue
            notices = [item.get('payload', {}).get('text', '') for item in api('/api/session/' + origin + '/inbox')['data']]
            if not started_at and any('] STARTED /pr-review' in text for text in notices):
                started_at = time.monotonic()
            if started_at and not stop_sent and time.monotonic() - started_at >= hold:
                # Sending through the TUI proves that its current conversation is
                # still the origin; a home/other-tab recovery cannot cancel it.
                os.write(fd, b'\x15/pr-stop ')
                stop_sent = True
                submitted_at = time.monotonic()
            if stop_sent and not stop_confirmed and time.monotonic() - submitted_at > 1:
                # Enter first accepts the slash-command completion, then sends.
                os.write(fd, b'\x1b[13u')
                stop_confirmed = True
            if stop_sent and any('] CANCELLED\n' in text for text in notices):
                cancelled = True
                break
        assert started_at, 'TUI never admitted the native command'
        assert cancelled, 'TUI did not retain its origin and cancel the admitted background run'
        session = api('/api/session/' + origin)['data']
        assert not session.get('time', {}).get('archived'), 'Origin was archived'
        (root / ('tui-' + label + '.json')).write_text(json.dumps({'origin': origin, 'startObserved': True,
             'heldSeconds': hold, 'cancelledFromSameTui': True, 'sessionRetained': True}, indent=2))
    finally:
        (root / ('tui-' + label + '.raw')).write_bytes(captured)
        if origin and not cancelled:
            api('/api/session/' + origin + '/command', {'name': 'pr-stop', 'text': ''})
        os.kill(pid, signal.SIGTERM)
        os.waitpid(pid, 0)
        os.close(fd)
print('New and existing TUI background sessions passed.')
