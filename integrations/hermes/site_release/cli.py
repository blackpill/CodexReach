"""Hermes client: fixed Unix socket, no keys, environment files or remote shell."""
import argparse,json,socket,os
from .config import get_target

def parser(target):
 p=argparse.ArgumentParser();subs=p.add_subparsers(dest='command',required=True)
 for name in ['prepare','prepare-rollback']:
  q=subs.add_parser(name);q.add_argument('--project',choices=[target.project],required=True)
  if name=='prepare-rollback':q.add_argument('--version-id',required=True)
 for name in ['status','locate-confirmation','confirm','cancel','reconcile']:
  q=subs.add_parser(name);q.add_argument('--release-id',required=True)
  if name=='confirm':q.add_argument('--message-id',required=True)
 return p

def main():
 target=get_target(os.environ["SITE_RELEASE_PROJECT"]);args=vars(parser(target).parse_args())
 try:
  with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
   s.settimeout(90);s.connect(target.socket);s.sendall(json.dumps(args).encode()+b'\n');raw=b''
   while b'\n' not in raw:
    data=s.recv(65536)
    if not data:raise ValueError()
    raw+=data
    if len(raw)>1_000_000:raise ValueError()
  d=json.loads(raw)
  print(json.dumps(d,ensure_ascii=False))
  if not d.get('ok'):raise SystemExit(1)
 except (OSError,ValueError):print('{"ok":false,"error":"Release service unavailable or request rejected"}');raise SystemExit(1)
if __name__=='__main__':main()
