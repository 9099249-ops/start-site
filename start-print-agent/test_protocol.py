import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
import main
import site_protocol
from tests import FakeCups

FIXTURE = json.loads((Path(__file__).parent/'examples/protocol-fixture.json').read_text(encoding='utf-8'))

def envelope(payload=None, operation='submit'):
    p = copy.deepcopy(payload or FIXTURE['payload'])
    return {'job_id': str(uuid.uuid4()), 'operation': operation, 'payload': p, 'payload_hash': main.payload_hash(p)}

class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = {'database': self.tmp.name+'/queue.db', 'printer':'test', 'printing_enabled':True,
                    'site_api_url':'https://spotsup.ru/api/print-agent/v1', 'poll_token':'test-token-'*5}
        self.agent = main.Agent(self.cfg)
        self.cups = FakeCups()
        self.raster = patch.object(main, 'render', return_value=b'test-raster')
        self.raster.start()

    def tearDown(self):
        self.raster.stop()
        self.tmp.cleanup()

    def test_shared_canonical_fixture(self):
        self.assertEqual(main.canonical(FIXTURE['payload']), FIXTURE['canonical'])
        self.assertEqual(main.payload_hash(FIXTURE['payload']), FIXTURE['sha256'])

    def test_receive_and_ack_are_durable_and_atomic(self):
        e = envelope()
        self.agent.store.receive_envelope(e)
        first = self.agent.store.outbox()
        self.assertEqual(first[0]['status'], 'received')
        database_id = self.agent.store.database_id()
        self.agent = main.Agent(self.cfg)
        self.agent.store.receive_envelope(e)
        self.assertEqual(self.agent.store.outbox(), first)
        self.assertEqual(self.agent.store.database_id(), database_id)
        self.assertEqual(len(self.agent.store.pending()), 1)
        self.agent.store.acknowledge([first[0]['event_id']])
        self.assertEqual(self.agent.store.outbox(), [])
        self.agent.store.receive_envelope(e)
        self.assertEqual(len(self.agent.store.pending()), 1)

    def test_outbox_failure_rolls_back_document_and_job(self):
        with patch.object(self.agent.store, 'emit', side_effect=RuntimeError('disk full')):
            with self.assertRaises(RuntimeError):
                self.agent.store.receive_envelope(envelope())
        with self.agent.store.db() as db:
            for table in ['orders','jobs','server_commands','event_outbox']:
                self.assertEqual(db.execute('SELECT count(*) FROM '+table).fetchone()[0], 0)

    def test_status_transitions_include_cups_id_and_survive_lost_ack(self):
        e = envelope()
        self.agent.store.receive_envelope(e)
        self.agent.step(self.cups)
        self.agent.step(self.cups)
        events = self.agent.store.outbox()
        self.assertEqual(events[-1]['status'], 'printed')
        self.assertEqual(events[-1]['cups_id'], 1)
        self.assertEqual([e['sequence'] for e in events], list(range(1,len(events)+1)))
        self.agent = main.Agent(self.cfg)
        self.agent.store.receive_envelope(e)
        self.agent.step(self.cups)
        self.assertEqual(self.cups.created, 1)
        self.assertEqual(self.agent.store.outbox(), events)

    def test_manual_reprint_command_is_idempotent_after_completion_and_restart(self):
        e = envelope()
        self.agent.store.receive_envelope(e)
        self.agent.step(self.cups); self.agent.step(self.cups)
        reprint = envelope(operation='reprint')
        with patch.dict('sys.modules', {'cups': type('Cups', (), {'Connection':lambda: type('Connection', (), {'getJobs':lambda *a,**k:{}})()})}):
            self.agent.store.receive_envelope(reprint)
        self.agent.step(self.cups); self.agent.step(self.cups)
        self.agent = main.Agent(self.cfg)
        self.agent.store.receive_envelope(reprint)
        self.agent.step(self.cups)
        self.assertEqual(self.cups.created, 2)
        with self.agent.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM jobs WHERE reprint=1').fetchone()[0], 1)

    def test_active_held_attempt_prevents_reprint(self):
        e = envelope()
        self.agent.store.receive_envelope(e)
        with patch.object(self.cups, 'writeRequestData', side_effect=OSError('lost')):
            with self.assertRaises(OSError): self.agent.step(self.cups)
        self.agent.step(self.cups)
        with patch.dict('sys.modules', {'cups': type('Cups', (), {'Connection':lambda: self.cups})}):
            self.agent.store.receive_envelope(envelope(operation='reprint'))
        with self.agent.store.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM jobs').fetchone()[0], 1)
        self.assertEqual(self.agent.store.outbox()[-1]['status'], 'failed')

    def test_invalid_payload_fails_once_without_poisoning_valid_documents(self):
        bad = envelope(); bad['payload']['total'] = '2.00'
        self.agent.store.receive_envelope(bad)
        self.agent.store.receive_envelope(bad)
        self.agent.store.receive_envelope(envelope())
        self.assertEqual([e['status'] for e in self.agent.store.outbox()], ['failed','received'])
        self.assertEqual(len(self.agent.store.pending()), 1)

    def test_queue_full_keeps_delivery_retryable(self):
        with patch.object(self.agent.store, 'receive', side_effect=main.QueueFull()):
            with self.assertRaises(main.QueueFull): self.agent.store.receive_envelope(envelope())
        self.assertEqual(self.agent.store.outbox(), [])

    def test_cafe_keeps_all_site_modifiers_and_long_comment(self):
        payload={'type':'cafe_order','order_id':'all-modifiers','order_number':'1','ticket_kind':'ADD',
                 'items':[{'name':'Блюдо','qty':1,'price':'1.00','modifiers':['Добавка '+str(i) for i in range(62)]}],
                 'comment':'а'*700+'Без соли','total':'1.00'}
        self.agent.store.receive_envelope(envelope(payload))
        self.assertEqual(len(self.agent.store.pending()),1)
        lines=main.receipt_lines(payload,main.now())
        self.assertIn('+ Добавка 61',lines)
        self.assertIn(payload['comment'],lines)

    def test_location_correction_is_not_a_second_food_order(self):
        payload = {'type': 'cafe_order', 'order_id': 'location-1', 'order_number': '12',
                   'ticket_kind': 'LOCATION', 'items': [], 'comment': 'Стол 7', 'total': '0.00'}
        self.agent.store.receive_envelope(envelope(payload))
        self.agent.store.receive_envelope(envelope(payload))
        self.assertEqual(len(self.agent.store.pending()), 1)
        lines = main.receipt_lines(payload, main.now())
        self.assertIn('УТОЧНЕНИЕ МЕСТА', lines)
        self.assertEqual(lines[lines.index('УТОЧНЕНИЕ МЕСТА') + 1], '012')
        self.assertIn('Стол 7', lines)
        self.assertNotIn('ИТОГО: 0.00 ₽', lines)
        self.assertTrue(any('НЕ НОВЫЙ ЗАКАЗ' in line for line in lines))

    def test_invalid_report_metadata_rejected_before_rendering(self):
        for field,value in [('revision','2'),('revision',True),('preliminary','false'),
                            ('as_of','not-a-date'),('as_of','2026-09-25T12:00:00')]:
            with self.subTest(field=field,value=value):
                payload=copy.deepcopy(FIXTURE['payload']); payload[field]=value
                self.agent.store.receive_envelope(envelope(payload))
                self.assertEqual(self.agent.store.outbox()[-1]['status'],'failed')
        self.assertEqual(self.agent.store.pending(),[])

    def test_status_and_outbox_update_are_atomic(self):
        self.agent.store.receive_envelope(envelope())
        job = self.agent.store.pending()[0]
        with patch.object(self.agent.store, 'emit', side_effect=RuntimeError('disk full')):
            with self.assertRaises(RuntimeError): self.agent.store.update(job['id'],status='printing')
        self.assertEqual(self.agent.store.pending()[0]['status'],'received')

    def test_lost_http_ack_reuses_event_ids(self):
        self.agent.store.receive_envelope(envelope())
        client = site_protocol.SiteClient(self.agent)
        events = self.agent.store.outbox()
        with patch.object(client,'request',side_effect=OSError('lost response')):
            with self.assertRaises(OSError): client.flush()
        self.assertEqual(self.agent.store.outbox(),events)
        with patch.object(client,'request',return_value={'accepted_event_ids':[e['event_id'] for e in events]}): client.flush()
        self.assertEqual(self.agent.store.outbox(),[])

    def test_no_unrequested_ack_delete_or_http_redirect(self):
        self.agent.store.receive_envelope(envelope())
        client=site_protocol.SiteClient(self.agent)
        with patch.object(client,'request',return_value={'accepted_event_ids':['wrong-id']}):
            with self.assertRaises(ValueError): client.flush()
        self.assertEqual(len(self.agent.store.outbox()),1)
        with self.assertRaises(ValueError): site_protocol.NoRedirect().redirect_request(None,None,None,None,None,None)
        for url in ['http://spotsup.ru/api','https://user:secret@spotsup.ru/api','https://spotsup.ru/api?token=secret']:
            with self.assertRaises(ValueError): site_protocol.SiteClient(main.Agent({**self.cfg,'site_api_url':url}))

    def test_new_empty_db_gets_different_pairing_id(self):
        other=main.Store(self.tmp.name+'/other.db')
        self.assertNotEqual(other.database_id(),self.agent.store.database_id())

    def test_preliminary_final_and_revision_labels(self):
        p=copy.deepcopy(FIXTURE['payload']); p['revision']=2
        lines='\n'.join(main.receipt_lines(p,main.now(),True))
        for text in ['ПРЕДВАРИТЕЛЬНЫЙ ОТЧЁТ','НОВАЯ РЕДАКЦИЯ 2','ПОВТОР','КАФЕ + ПРОКАТ','3500.00 ₽']: self.assertIn(text,lines)
        p['as_of']='2026-09-25T12:34:00Z'
        self.assertIn('Снимок: 25.09.2026 15:34 МСК',main.receipt_lines(p,main.now()))
        p['preliminary']=False
        self.assertIn('ИТОГОВЫЙ ОТЧЁТ',main.receipt_lines(p,main.now()))

if __name__=='__main__': unittest.main(verbosity=2)
