"""Presentation boundaries on the real embedded CLI module; no network/model."""
import runpy
import unittest
from pathlib import Path
from unittest.mock import patch
load = runpy.run_path(str(Path(__file__).with_name('test-chat-destination.py')))['load']

class TerminalUI(unittest.TestCase):
    def test_redirected_replies_are_byte_for_byte_plain(self):
        ns=load();out=[];ns['say']=out.append;ns['terminal_ui']=lambda:False
        text='line one\nUnicode café';ns['render_reply'](text)
        self.assertEqual(out,[text])

    def test_no_color_and_model_control_sequences(self):
        ns=load();out=[];ns['say']=out.append;ns['terminal_ui']=lambda:True
        with patch.dict(ns['os'].environ,{'NO_COLOR':''}):
            self.assertEqual(ns['accent']('TARX'),'TARX')
            ns['render_reply']('safe\x1b[2J\x9b31m\nreply')
        self.assertNotIn('\x1b',''.join(out));self.assertNotIn('\x9b',''.join(out))
        self.assertIn('reply',''.join(out))

    def test_long_input_stays_inside_frame_without_changing_payload(self):
        ns=load();text='private context '*800
        line,caret=ns['input_frame'](text,len(text),40)
        self.assertEqual(len(line),40);self.assertLess(caret,39)
        self.assertEqual(text,'private context '*800)
        line,caret=ns['input_frame']('漢字 café\nnext',2,40)
        self.assertEqual(caret,8);self.assertIn('↵',line)

    def test_startup_summary_and_full_help_remain_distinct(self):
        ns=load();out=[];ns['say']=out.append;ns['terminal_ui']=lambda:True;ns['accent']=lambda x,*_:x
        ns['show_commands']();self.assertEqual(len(out),1)
        out.clear();ns['handle_command']('/help')
        self.assertGreater(len(out),5);self.assertTrue(any('/signout' in x for x in out))

if __name__=='__main__':unittest.main()
