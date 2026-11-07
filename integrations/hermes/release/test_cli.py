import unittest
from integrations.hermes.release.cli import parser
class CliTests(unittest.TestCase):
 def test_no_other_projects_or_commands_or_paths(self):
  import contextlib,io
  for args in [['prepare','--project','usmapgames'],['shell'],['status','--release-id','x','--config','/etc/passwd']]:
   with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):parser().parse_args(args)
