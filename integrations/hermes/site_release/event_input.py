"""Read the workflow receipt without putting it in shell/step environment logs."""
import json,re
from pathlib import Path

def read_ticket_from_event(path: Path) -> str:
 try:
  with path.open('rb') as stream:raw=stream.read(1000001)
  if len(raw)>1000000:raise ValueError()
  ticket=json.loads(raw)['inputs']['approval_ticket']
  if not isinstance(ticket,str) or not 0<len(ticket)<=12000 or re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',ticket) is None:raise ValueError()
  return ticket
 except (ValueError,KeyError,TypeError,OSError):raise ValueError('Invalid workflow receipt input') from None
