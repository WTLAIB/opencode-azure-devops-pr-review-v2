#!/usr/bin/env python3
"""Record an actual terminal as asciicast v2 without changing its output.

Optional control JSONL: {"text": "/pr-check ..."}, {"key": "submit"}.
No credentials, environment, or command arguments are copied into the cast.
The recording itself can contain private data; inspect it before publication.
"""
import argparse
import codecs
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--control', type=Path, help='Private append-only JSONL control file')
parser.add_argument('--cwd', type=Path, default=Path.cwd())
parser.add_argument('--columns', type=int, default=128)
parser.add_argument('--rows', type=int, default=38)
parser.add_argument('command', nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[:1] == ['--'] else args.command
if not command:
    parser.error('Supply the terminal command after --')
if not 40 <= args.columns <= 240 or not 10 <= args.rows <= 100:
    parser.error('Unsupported terminal dimensions')
os.umask(0o077)
args.output.parent.mkdir(parents=True, exist_ok=True)
recording = args.output.open('x', encoding='utf-8')
recording.write(json.dumps({'version': 2, 'width': args.columns, 'height': args.rows,
                           'timestamp': int(time.time()),
                           'env': {'TERM': 'xterm-256color', 'SHELL': '/bin/sh'}}) + '\n')
recording.flush()
started = time.monotonic()
pid, descriptor = pty.fork()
if pid == 0:
    os.chdir(args.cwd)
    env = {**os.environ, 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
           'COLUMNS': str(args.columns), 'LINES': str(args.rows)}
    os.execvpe(command[0], command, env)
fcntl.ioctl(descriptor, termios.TIOCSWINSZ, struct.pack('HHHH', args.rows, args.columns, 0, 0))
stop = False


def stopping(_number, _frame):
    global stop
    stop = True


signal.signal(signal.SIGINT, stopping)
signal.signal(signal.SIGTERM, stopping)
decoder = codecs.getincrementaldecoder('utf-8')('replace')
control_offset = 0
control_pending = b''
keys = {'submit': b'\x1b[13u', 'enter': b'\r', 'escape': b'\x1b',
        'page-up': b'\x1b[5~', 'page-down': b'\x1b[6~', 'clear-input': b'\x15'}
print(json.dumps({'status': 'recording', 'pid': os.getpid(), 'terminalPid': pid}), flush=True)
try:
    while not stop:
        if select.select([descriptor], [], [], 0.1)[0]:
            try:
                chunk = os.read(descriptor, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            text = decoder.decode(chunk)
            if text:
                recording.write(json.dumps([round(time.monotonic() - started, 6), 'o', text]) + '\n')
                recording.flush()
            # Answer terminal capability queries, exactly as a terminal does.
            if b'\x1b[6n' in chunk:
                os.write(descriptor, b'\x1b[1;1R')
            if b'\x1b[c' in chunk:
                os.write(descriptor, b'\x1b[?1;2c')
        if args.control and args.control.exists():
            with args.control.open('rb') as control:
                control.seek(control_offset)
                addition = control.read()
                control_offset = control.tell()
            control_pending += addition
            while b'\n' in control_pending:
                line, control_pending = control_pending.split(b'\n', 1)
                if not line.strip():
                    continue
                action = json.loads(line)
                if set(action) == {'text'} and isinstance(action['text'], str):
                    os.write(descriptor, action['text'].encode())
                elif set(action) == {'key'} and action['key'] in keys:
                    os.write(descriptor, keys[action['key']])
                else:
                    raise ValueError('Unknown terminal control action')
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    while True:
        waited, child_status = os.waitpid(pid, os.WNOHANG)
        if waited:
            break
        if time.monotonic() >= deadline:
            os.kill(pid, signal.SIGKILL)
            _, child_status = os.waitpid(pid, 0)
            break
        time.sleep(0.05)
    os.close(descriptor)
    tail = decoder.decode(b'', final=True)
    if tail:
        recording.write(json.dumps([round(time.monotonic() - started, 6), 'o', tail]) + '\n')
    recording.close()
print(json.dumps({'status': 'stopped', 'seconds': round(time.monotonic() - started, 3),
                  'terminalExitCode': os.waitstatus_to_exitcode(child_status)}), flush=True)
