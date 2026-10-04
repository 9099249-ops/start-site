import concurrent.futures
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import main

ORDER = json.loads((Path(__file__).parent/'examples/order.json').read_text(encoding='utf-8'))

class FakeCups:
    def __init__(self):
        self.jobs = {}; self.created = 0; self.released = 0; self.data = b''
    def getPrinters(self):
        return {'test': {'printer-state': 3, 'printer-is-accepting-jobs': True}}
    def createJob(self, printer, title, options):
        assert options['job-hold-until'] == 'indefinite'
        self.created += 1
        self.jobs[self.created] = {'job-name': title, 'job-state': 4}
        return self.created
    def startDocument(self, *a): return 100
    def writeRequestData(self, data, size): self.data += data; return 100
    def finishDocument(self, *a): return 0
    def getJobs(self, **kw): return self.jobs
    def getJobAttributes(self, jid): return self.jobs[jid]
    def setJobHoldUntil(self, jid, hold):
        assert hold == 'no-hold'
        self.released += 1; self.jobs[jid]['job-state'] = 9

class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = {'database': self.tmp.name+'/queue.db', 'printer':'test', 'printing_enabled':True}
        if Path('C:/Windows/Fonts/arial.ttf').exists(): self.cfg['font_path']='C:/Windows/Fonts/arial.ttf'
        self.a = main.Agent(self.cfg); self.c = FakeCups()
    def tearDown(self): self.tmp.cleanup()
    def test_concurrent_duplicates(self):
        with concurrent.futures.ThreadPoolExecutor(8) as pool:
            rows = list(pool.map(lambda _: self.a.store.receive(ORDER), range(20)))
        self.assertEqual(sum(not duplicate for _,duplicate in rows), 1)
        self.assertEqual(len(self.a.store.pending()),1)
    def test_conflicting_payload(self):
        self.a.store.receive(ORDER)
        changed = copy.deepcopy(ORDER); changed['total']=401
        with self.assertRaises(ValueError): self.a.store.receive(changed)
    def test_print_once_across_restart(self):
        self.a.store.receive(ORDER)
        self.a.step(self.c)
        self.a = main.Agent(self.cfg)
        self.a.step(self.c); self.a.step(self.c)
        self.a.store.receive(ORDER); self.a.step(self.c)
        self.assertEqual((self.c.created,self.c.released),(1,1))
        self.assertEqual(self.a.store.pending(),[])
        self.assertTrue(self.c.data.startswith(b'\x1b@'))
    def test_interrupted_upload_never_reprints(self):
        self.a.store.receive(ORDER)
        with patch.object(self.c,'writeRequestData',side_effect=OSError('lost')):
            with self.assertRaises(OSError): self.a.step(self.c)
        main.Agent(self.cfg).step(self.c)
        self.assertEqual((self.c.created,self.c.released),(1,0))
        with self.a.store.db() as db:
            self.assertEqual(db.execute('SELECT status FROM jobs').fetchone()[0],'failed')
    def test_interrupted_creation_recovers_held_id(self):
        row,_=self.a.store.receive(ORDER)
        jid=self.c.createJob('test',row['token'],{'job-hold-until':'indefinite'})
        self.a.store.update(row['id'],status='printing',phase='creating')
        self.a.step(self.c)
        with self.a.store.db() as db:
            r=db.execute('SELECT * FROM jobs').fetchone()
            self.assertEqual((r['status'],r['cups_id']),('failed',jid))
        self.assertEqual(self.c.released,0)
    def test_sent_job_released_after_restart(self):
        row,_=self.a.store.receive(ORDER)
        jid=self.c.createJob('test',row['token'],{'job-hold-until':'indefinite'})
        self.a.store.update(row['id'],status='printing',phase='sent',cups_id=jid)
        main.Agent(self.cfg).step(self.c)
        self.assertEqual((self.c.created,self.c.released),(1,1))
    def test_missing_printer_keeps_queue(self):
        self.a.store.receive(ORDER)
        with patch.object(self.c,'getPrinters',return_value={}):
            with self.assertRaises(RuntimeError): self.a.step(self.c)
        self.assertEqual(self.a.store.pending()[0]['status'],'received')
    def test_manual_reprint_and_active_guard(self):
        row,_=self.a.store.receive(ORDER)
        with self.assertRaises(ValueError): self.a.store.reprint('cafe_order','TEST-002')
        self.a.store.update(row['id'],status='failed')
        new=self.a.store.reprint('cafe_order','TEST-002')
        self.assertEqual(new['reprint'],1)
        self.a.step(self.c); self.a.step(self.c)
        self.assertEqual(self.c.created,1)
    def test_buzzer_is_part_of_cafe_job_only(self):
        cfg = {**self.cfg, 'beep_hex': '1b420909', 'beep_cafe_only': True}
        sound = bytes.fromhex(cfg['beep_hex']) + b'\x1dV\x01'
        _, _, order = main.validate(ORDER)
        self.assertTrue(main.render(order, main.now(), cfg).endswith(sound))
        self.assertTrue(main.render({**order, 'ticket_kind': 'ADD'}, main.now(), cfg).endswith(sound))
        for kind in ('CANCELLED', 'LOCATION'):
            self.assertFalse(main.render({**order, 'ticket_kind': kind}, main.now(), cfg).endswith(sound))
        report = json.loads((Path(__file__).parent/'examples/shift-report.json').read_text(encoding='utf-8'))
        _, _, report = main.validate(report)
        self.assertFalse(main.render(report, main.now(), cfg).endswith(sound))
        self.assertFalse(main.render(order, main.now(), self.cfg).endswith(sound))
        for source, count in [('admin', 1), ('site', 4)]:
            ticket = {**order, 'order_source': source}
            main.validate(ticket)
            expected = bytes([27, 66, count, 9]) + b'\x1dV\x01'
            for kind in ('NEW', 'ADD'):
                self.assertTrue(main.render({**ticket, 'ticket_kind': kind}, main.now(), cfg).endswith(expected))
            for kind in ('CANCELLED', 'LOCATION'):
                self.assertFalse(main.render({**ticket, 'ticket_kind': kind}, main.now(), cfg).endswith(expected))
        with self.assertRaises(ValueError):
            main.validate({**order, 'order_source': 'invalid'})

    def test_report_cyrillic_raster(self):
        report=json.loads((Path(__file__).parent/'examples/shift-report.json').read_text(encoding='utf-8'))
        _,_,data=main.validate(report)
        self.assertIn('КОМУ СКОЛЬКО ПЕРЕВЕСТИ:',main.receipt_lines(data,main.now()))
        self.assertGreater(len(main.render(data,main.now(),self.cfg)),1000)

    def test_report_preserves_payroll_review_warning(self):
        report=json.loads((Path(__file__).parent/'examples/shift-report.json').read_text(encoding='utf-8'))
        report['source']='Ранее выплаченная зарплата требует сверки суммы, повторно не выдавать'
        _,_,data=main.validate(report)
        lines=main.receipt_lines(data,main.now())
        self.assertIn(report['source'],lines)
        self.assertNotIn('Только за эту смену; выплаты учтены.',lines)

if __name__ == '__main__': unittest.main(verbosity=2)
