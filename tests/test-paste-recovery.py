import ast, os, pty, select, struct, subprocess, sys, termios, fcntl, time, json
from pathlib import Path
source=(Path(__file__).resolve().parents[1] / 'tarx').read_text()
start=source.index('def read_message():'); end=source.index('\ndef ',start+5)
function=source[start:end]
ast.parse(function)
def run(payload,expected):
 master,slave=pty.openpty()
 fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',24,40,0,0))
 code='import sys,os,select,json\n'+function+'\nprint("RESULT="+json.dumps(read_message()))\n'
 child=subprocess.Popen([sys.executable,'-c',code],stdin=slave,stdout=slave,stderr=slave,close_fds=True)
 os.close(slave); output=b''; deadline=time.monotonic()+5
 while b'\x1b[?2004h' not in output and time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:output+=os.read(master,65536)
 os.write(master,payload)
 while time.monotonic()<deadline:
  if select.select([master],[],[],.1)[0]:
   try:output+=os.read(master,65536)
   except OSError:break
  if child.poll() is not None:break
 if child.poll() is None:child.kill()
 child.wait();os.close(master)
 text=output.decode(errors='replace'); result=text.split('RESULT=')[-1].strip()
 return {'returned_expected':json.loads(result)==expected,'clear_current_line_count':output.count(b'\x1b[2K'),'cursor_up_present':b'\x1b[A' in output,'terminal_columns':40,'output_bytes':len(output)}
results={'long_typed':run(b'x'*120+b'\r','x'*120+'\n'),'multiline_paste':run(b'\x1b[200~first\nsecond\x1b[201~\r','first\nsecond\n'),'unicode':run('café 界'.encode()+b'\r','café 界\n')}
print(json.dumps(results,indent=2))
assert all(x['returned_expected'] for x in results.values())

assert run(b"abc\x13def\r", "abcdef\n")["returned_expected"]
assert run(b"\x1b[200~hello\nworld\x07\r", "hello\nworld\n")["returned_expected"]
