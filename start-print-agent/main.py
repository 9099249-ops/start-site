#!/usr/bin/python3
"""Durable local print agent. CUPS completion is transport completion, not paper proof."""
import argparse
from contextlib import contextmanager
try:
    import fcntl
except ImportError:  # Queue/protocol tests also run on Windows; serving remains Linux-only.
    fcntl = None
import hashlib
import hmac
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import secrets
import signal
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, unquote
from zoneinfo import ZoneInfo

CONFIG = os.environ.get('START_PRINT_CONFIG', '/etc/start-print-agent/config.json')
STOP = threading.Event()
LOG = logging.getLogger('start-print-agent')

class QueueFull(Exception):
    pass

def canonical(data):
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def payload_hash(data):
    return hashlib.sha256(canonical(data).encode('utf-8')).hexdigest()

def now():
    return datetime.now(ZoneInfo('Europe/Moscow')).isoformat(timespec='seconds')

def money(value):
    if isinstance(value, bool):
        raise ValueError('invalid money')
    try:
        n = Decimal(str(value))
        if not n.is_finite() or abs(n) > 1000000000:
            raise ValueError('invalid money')
        return format(n.quantize(Decimal('.01')), 'f')
    except InvalidOperation as exc:
        raise ValueError('invalid money') from exc

def label(value, limit=500):
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 and c != '\n' for c in value):
        raise ValueError('invalid text')
    return value

def validate(data):
    if not isinstance(data, dict):
        raise ValueError('JSON object required')
    data = json.loads(json.dumps(data, ensure_ascii=False, allow_nan=False))
    kind = data.setdefault('type', 'cafe_order')
    if kind not in ('cafe_order', 'shift_report'):
        raise ValueError('unknown type')
    ident = data.get('order_id') if kind == 'cafe_order' else data.get('report_id')
    if not label(ident, 128).strip() or '\n' in ident:
        raise ValueError('non-empty order_id/report_id required')
    if kind == 'cafe_order':
        items = data.get('items')
        if not isinstance(items, list) or not (0 if data.get('ticket_kind') == 'LOCATION' else 1) <= len(items) <= 100:
            raise ValueError('1..100 items required')
        for item in items:
            label(item['name'], 200)
            qty = Decimal(str(item['qty']))
            if not qty.is_finite() or not 0 < qty <= 10000:
                raise ValueError('invalid qty')
            if 'price' in item:
                item['price'] = money(item['price'])
            mods = item.get('modifiers', [])
            if not isinstance(mods, list) or len(mods) > 62:
                raise ValueError('invalid modifiers')
            for mod in mods:
                label(mod, 200)
        for key in ('customer_name', 'fulfillment', 'table'):
            if key in data:
                label(data[key])
        if 'comment' in data:
            label(data['comment'], 1500)
        if 'order_number' in data:
            label(data['order_number'], 128)
        if 'ticket_kind' in data and data['ticket_kind'] not in ('NEW', 'ADD', 'CANCELLED', 'LOCATION'):
            raise ValueError('invalid ticket_kind')
        if 'order_source' in data and data['order_source'] not in ('admin', 'site'):
            raise ValueError('invalid order_source')
    else:
        datetime.strptime(data['date'], '%Y-%m-%d')
        label(data['shift_id'], 128)
        if 'preliminary' in data and not isinstance(data['preliminary'], bool):
            raise ValueError('invalid preliminary flag')
        if 'revision' in data and (type(data['revision']) is not int or not 1 <= data['revision'] <= 1000000):
            raise ValueError('invalid revision')
        if 'source' in data:
            label(data['source'])
        if 'as_of' in data:
            label(data['as_of'], 64)
            stamp = datetime.fromisoformat(data['as_of'].replace('Z', '+00:00'))
            if stamp.tzinfo is None:
                raise ValueError('as_of must include timezone')
        transfers = data['transfers']
        if not isinstance(transfers, list) or len(transfers) > 100:
            raise ValueError('invalid transfers')
        for row in transfers:
            label(row['recipient'], 200)
            row['amount'] = money(row['amount'])
    data['total'] = money(data['total'])
    return kind, ident, data

def receipt_lines(data, received, reprint=False):
    lines = ['КАФЕ СТАРТ', '']
    if reprint:
        lines += ['*** ПОВТОР ***', '']
    if data['type'] == 'shift_report':
        if data.get('revision', 1) > 1:
            lines += ['НОВАЯ РЕДАКЦИЯ ' + str(data['revision'])]
        lines += ['ПРЕДВАРИТЕЛЬНЫЙ ОТЧЁТ' if data.get('preliminary') else 'ИТОГОВЫЙ ОТЧЁТ', 'Дата: ' + data['date'], 'Смена: ' + data['shift_id'], '',
                  'КАФЕ + ПРОКАТ', 'СУММА ЗА СМЕНУ: ' + data['total'] + ' ₽', '',
                  'КОМУ СКОЛЬКО ПЕРЕВЕСТИ:']
        for row in data['transfers']:
            lines += [row['recipient'], row['amount'] + ' ₽']
        if not data['transfers']:
            lines += ['Переводов нет']
        lines += ['Всего к выплате: ' + money(sum(Decimal(r['amount']) for r in data['transfers'])) + ' ₽',
                  'Только за эту смену; выплаты учтены.']
        if data.get('preliminary'):
            lines += ['Предварительно, до сверки кассы.']
        if data.get('as_of'):
            stamp = datetime.fromisoformat(data['as_of'].replace('Z', '+00:00')).astimezone(ZoneInfo('Europe/Moscow'))
            lines += ['Снимок: ' + stamp.strftime('%d.%m.%Y %H:%M') + ' МСК']
        lines += ['', 'Отчёт: ' + data['report_id']]
    else:
        caption = {'ADD': 'ДОЗАКАЗ', 'CANCELLED': 'ОТМЕНА ЗАКАЗА', 'LOCATION': 'УТОЧНЕНИЕ МЕСТА'}.get(data.get('ticket_kind'), 'ЗАКАЗ')
        lines += [caption + ' № ' + data.get('order_number', data['order_id']), '']
        if data.get('table'):
            lines += ['Стол: ' + data['table']]
        fulfillment = {'lounge': 'Лаунж-зона', 'takeaway': 'С собой', 'delivery': 'Доставка'}.get(data.get('fulfillment'), data.get('fulfillment', ''))
        if fulfillment:
            lines += ['Получение: ' + fulfillment]
        if data.get('customer_name'):
            lines += ['Гость: ' + data['customer_name']]
        lines += ['']
        for item in data['items']:
            line = str(item['qty']) + ' × ' + item['name']
            if 'price' in item:
                line += ' — ' + item['price'] + ' ₽'
            lines += [line] + ['+ ' + m for m in item.get('modifiers', [])] + ['']
        if data.get('ticket_kind') == 'LOCATION':
            lines += ['НЕ НОВЫЙ ЗАКАЗ. Изменилось только место.']
        else:
            lines += ['ИТОГО: ' + data['total'] + ' ₽']
        if data.get('comment'):
            lines += ['', 'Комментарий:', data['comment']]
    lines += ['', 'Получено: ' + received, 'Печать: ' + now()]
    return lines

def render(data, received, cfg, reprint=False):
    from PIL import Image, ImageDraw, ImageFont
    width = int(cfg.get('width_dots', 576))
    if width < 384 or width > 640 or width % 8:
        raise ValueError('invalid width_dots')
    font = ImageFont.truetype(cfg.get('font_path', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'), 24)
    probe = ImageDraw.Draw(Image.new('L', (width, 1), 255))
    wrapped = []
    for line in receipt_lines(data, received, reprint):
        for paragraph in line.split('\n'):
            buf = ''
            for char in paragraph:
                if buf and probe.textlength(buf + char, font=font) > width - 16:
                    wrapped.append(buf)
                    buf = ''
                buf += char
            wrapped.append(buf)
    out = bytearray(b'\x1b@\x1ba\x00')
    # Small raster bands avoid excessive printer buffer/memory use.
    for line in wrapped:
        im = Image.new('L', (width, 34), 255)
        ImageDraw.Draw(im).text((8, 0), line, font=font, fill=0)
        bits = im.point(lambda p: 255 if p >= 160 else 0).convert('1').tobytes()
        out += b'\x1dv0\x00' + (width // 8).to_bytes(2, 'little') + (34).to_bytes(2, 'little')
        out += bytes(b ^ 255 for b in bits)
    out += b'\n\n\n'
    # Confirmed on the station printer. Keep sound in the same durable print job.
    audible = data['type'] == 'cafe_order' and data.get('ticket_kind') not in ('CANCELLED', 'LOCATION')
    if cfg.get('beep_hex') and (not cfg.get('beep_cafe_only', False) or audible):
        sound = bytes.fromhex(cfg['beep_hex'])
        # ESC B n t: change only the repeat count, retaining the tested duration.
        if audible and data.get('order_source') in ('admin', 'site') and len(sound) == 4 and sound[:2] == b'\x1bB':
            sound = sound[:2] + bytes([1 if data['order_source'] == 'admin' else 4]) + sound[3:]
        out += sound
    if cfg.get('cut', True):
        out += b'\x1dV\x01'
    return bytes(out)

class Store:
    def __init__(self, path):
        self.path = str(path)
        with self.db() as db:
            db.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS orders (
              kind TEXT NOT NULL, external_id TEXT NOT NULL, payload TEXT NOT NULL,
              received TEXT NOT NULL, PRIMARY KEY(kind, external_id));
            CREATE TABLE IF NOT EXISTS jobs (
              id INTEGER PRIMARY KEY, kind TEXT NOT NULL, external_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'received', phase TEXT NOT NULL DEFAULT 'new',
              token TEXT UNIQUE NOT NULL, cups_id INTEGER, reprint INTEGER NOT NULL DEFAULT 0,
              created TEXT NOT NULL, finished TEXT, error TEXT, error_time TEXT);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS server_commands (
              job_id TEXT PRIMARY KEY, local_job_id INTEGER REFERENCES jobs(id),
              payload_hash TEXT NOT NULL, operation TEXT NOT NULL, attempt_id TEXT NOT NULL,
              sequence INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS event_outbox (
              event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, sequence INTEGER NOT NULL, body TEXT NOT NULL);
            ''')
            db.execute('INSERT OR IGNORE INTO meta VALUES (?,?)', ('database_id', str(uuid.uuid4())))

    def database_id(self):
        with self.db() as db:
            return db.execute("SELECT value FROM meta WHERE key='database_id'").fetchone()[0]

    def emit(self, db, command, status, cups_id=None):
        sequence = command['sequence'] + 1
        event_id = str(uuid.uuid4())
        event = {'event_id': event_id, 'job_id': command['job_id'], 'attempt_id': command['attempt_id'],
                 'sequence': sequence, 'status': status, 'payload_hash': command['payload_hash'],
                 'occurred_at': now(), 'cups_id': cups_id}
        db.execute('INSERT INTO event_outbox VALUES (?,?,?,?)', (event_id, command['job_id'], sequence, canonical(event)))
        db.execute('UPDATE server_commands SET sequence=? WHERE job_id=?', (sequence, command['job_id']))

    def attach(self, db, envelope, row):
        if envelope is None:
            return
        old = db.execute('SELECT * FROM server_commands WHERE job_id=?', (envelope['job_id'],)).fetchone()
        if old:
            if old['payload_hash'] != envelope['payload_hash'] or old['operation'] != envelope['operation']:
                raise ValueError('server command conflict')
            return
        db.execute('INSERT INTO server_commands(job_id,local_job_id,payload_hash,operation,attempt_id) VALUES(?,?,?,?,?)',
                   (envelope['job_id'], row['id'], envelope['payload_hash'], envelope['operation'], row['token']))
        command = db.execute('SELECT * FROM server_commands WHERE job_id=?', (envelope['job_id'],)).fetchone()
        self.emit(db, command, row['status'], row['cups_id'])

    def outbox(self):
        with self.db() as db:
            return [json.loads(r[0]) for r in db.execute('SELECT body FROM event_outbox ORDER BY rowid LIMIT 100')]

    def acknowledge(self, event_ids):
        with self.db() as db:
            db.executemany('DELETE FROM event_outbox WHERE event_id=?', [(i,) for i in event_ids])

    def reject(self, envelope):
        # Permanent invalid documents are reported once, without touching CUPS.
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM server_commands WHERE job_id=?', (envelope['job_id'],)).fetchone():
                return
            db.execute('INSERT INTO server_commands(job_id,payload_hash,operation,attempt_id) VALUES(?,?,?,?)',
                       (envelope['job_id'], envelope['payload_hash'], envelope['operation'], 'rejected-' + uuid.uuid4().hex))
            self.emit(db, db.execute('SELECT * FROM server_commands WHERE job_id=?', (envelope['job_id'],)).fetchone(), 'failed')

    def receive_envelope(self, envelope):
        if not isinstance(envelope, dict) or envelope.get('operation') not in ('submit', 'reprint'):
            raise ValueError('invalid envelope')
        for key in ('job_id', 'payload_hash'):
            value = envelope.get(key)
            if not isinstance(value, str) or not value or len(value) > 128 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in value):
                raise ValueError('invalid envelope identifier')
        try:
            data = envelope['payload']
            kind, ident, normalized = validate(data)
            if payload_hash(data) != envelope['payload_hash'] or payload_hash(normalized) != envelope['payload_hash']:
                raise ValueError('payload hash mismatch')
            with self.db() as db:
                command = db.execute('SELECT * FROM server_commands WHERE job_id=?', (envelope['job_id'],)).fetchone()
                if command:
                    if command['payload_hash'] != envelope['payload_hash'] or command['operation'] != envelope['operation']:
                        raise ValueError('server command conflict')
                    return dict(db.execute('SELECT * FROM jobs WHERE id=?', (command['local_job_id'],)).fetchone()) if command['local_job_id'] else None
            if envelope['operation'] == 'submit':
                return self.receive(normalized, envelope)
            return self.reprint(kind, ident, envelope)
        except (ValueError, KeyError, TypeError, InvalidOperation):
            self.reject(envelope)
            LOG.error('invalid_server_job id=%s; manual inspection required', envelope['job_id'])
            return None

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()

    def receive(self, data, envelope=None):
        kind, ident, data = validate(data)
        payload = json.dumps(data, sort_keys=True, ensure_ascii=False)
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT payload FROM orders WHERE kind=? AND external_id=?', (kind, ident)).fetchone()
            if old:
                if old['payload'] != payload:
                    raise ValueError('ID already exists with different data; use a new report revision ID')
                row = dict(db.execute('SELECT * FROM jobs WHERE kind=? AND external_id=? AND reprint=0', (kind, ident)).fetchone())
                self.attach(db, envelope, row)
                return row, True
            if db.execute("SELECT count(*) FROM jobs WHERE status IN ('received','printing')").fetchone()[0] >= 10000:
                raise QueueFull('local queue is full; retry delivery later')
            db.execute('INSERT INTO orders VALUES (?,?,?,?)', (kind, ident, payload, now()))
            cursor = db.execute('INSERT INTO jobs(kind,external_id,token,created) VALUES(?,?,?,?)', (kind, ident, 'start-' + uuid.uuid4().hex, now()))
            row = dict(db.execute('SELECT * FROM jobs WHERE id=?', (cursor.lastrowid,)).fetchone())
            self.attach(db, envelope, row)
        LOG.info('received kind=%s id=%s job=%s', kind, ident, row['id'])
        return row, False

    def reprint(self, kind, ident, envelope=None):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if envelope:
                command = db.execute('SELECT * FROM server_commands WHERE job_id=?', (envelope['job_id'],)).fetchone()
                if command:
                    if command['payload_hash'] != envelope['payload_hash'] or command['operation'] != 'reprint':
                        raise ValueError('server command conflict')
                    return dict(db.execute('SELECT * FROM jobs WHERE id=?', (command['local_job_id'],)).fetchone()) if command['local_job_id'] else None
            if not db.execute('SELECT 1 FROM orders WHERE kind=? AND external_id=?', (kind, ident)).fetchone():
                raise ValueError('unknown order/report')
            last = db.execute('SELECT * FROM jobs WHERE kind=? AND external_id=? ORDER BY id DESC LIMIT 1', (kind, ident)).fetchone()
            if last['status'] not in ('printed', 'failed'):
                raise ValueError('existing job is still active')
            if envelope:
                original = json.loads(db.execute('SELECT payload FROM orders WHERE kind=? AND external_id=?', (kind, ident)).fetchone()[0])
                if payload_hash(original) != envelope['payload_hash']:
                    raise ValueError('reprint payload conflict')
            # Check EVERY earlier attempt, including interrupted creation without an ID.
            earlier = db.execute('SELECT * FROM jobs WHERE kind=? AND external_id=?', (kind, ident)).fetchall()
            if any(j['status'] in ('received', 'printing') for j in earlier):
                raise ValueError('existing attempt is still active')
            if any(j['cups_id'] or j['phase'] != 'new' for j in earlier):
                import cups
                c = cups.Connection()
                active = c.getJobs(which_jobs='not-completed', my_jobs=False)
                if any(j['cups_id'] in active or any(a.get('job-name') == j['token'] for a in active.values()) for j in earlier):
                    raise ValueError('old CUPS job is active/held; inspect and cancel it first')
            cur = db.execute('INSERT INTO jobs(kind,external_id,token,reprint,created) VALUES(?,?,?,1,?)', (kind, ident, 'start-' + uuid.uuid4().hex, now()))
            job = dict(db.execute('SELECT * FROM jobs WHERE id=?', (cur.lastrowid,)).fetchone())
            self.attach(db, envelope, job)
        LOG.warning('manual_reprint kind=%s id=%s job=%s', kind, ident, job['id'])
        return job

    def update(self, job_id, **values):
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('UPDATE jobs SET ' + ','.join(k + '=?' for k in values) + ' WHERE id=?', [*values.values(), job_id])
            row = db.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
            for command in db.execute('SELECT * FROM server_commands WHERE local_job_id=?', (job_id,)).fetchall():
                self.emit(db, command, row['status'], row['cups_id'])

    def event_error(self, error):
        with self.db() as db:
            db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', ('last_error', json.dumps({'time': now(), 'message': str(error)})))

    def pending(self):
        with self.db() as db:
            return [dict(r) for r in db.execute("SELECT j.*,o.payload,o.received FROM jobs j JOIN orders o USING(kind,external_id) WHERE j.status IN ('received','printing') ORDER BY j.id")]

class Agent:
    def __init__(self, cfg):
        self.cfg = cfg
        self.store = Store(cfg['database'])
        self.online = None

    def health(self):
        result = {'agent': 'running', 'time': now(), 'cups': False, 'printer_configured': False,
                  'printing_enabled': bool(self.cfg.get('printing_enabled')),
                  'printer_available': False, 'physical_print_confirmed': False,
                  'completion_semantics': 'CUPS completed; paper output requires device/operator confirmation'}
        with self.store.db() as db:
            result['counts'] = {r[0]: r[1] for r in db.execute('SELECT status,count(*) FROM jobs GROUP BY status')}
            result['queue_length'] = sum(result['counts'].get(s, 0) for s in ('received', 'printing'))
            r = db.execute("SELECT kind,external_id,finished FROM jobs WHERE status='printed' ORDER BY id DESC LIMIT 1").fetchone()
            result['last_success'] = dict(r) if r else None
            r = db.execute("SELECT value FROM meta WHERE key='last_error'").fetchone()
            result['last_error'] = json.loads(r[0]) if r else None
        try:
            import cups
            printers = cups.Connection().getPrinters()
            result['cups'] = True
            p = printers.get(self.cfg.get('printer', ''))
            result['printer_configured'] = bool(p)
            if p:
                result['printer_available'] = None
                result['printer_state'] = p.get('printer-state')
                result['printer_reasons'] = p.get('printer-state-reasons', [])
                result['printer_message'] = p.get('printer-state-message', '')
                # CUPS idle does not prove a USB printer is physically online.
                if p.get('printer-state') == 5:
                    result['printer_available'] = False
        except Exception as exc:
            result['cups_error'] = str(exc)
        return result

    def fail(self, row, message):
        self.store.update(row['id'], status='failed', error=message, error_time=now())
        self.store.event_error(message)
        LOG.error('failed id=%s job=%s error=%s', row['external_id'], row['id'], message)

    def step(self, c):
        printers = c.getPrinters()
        printer = self.cfg.get('printer', '')
        for row in self.store.pending():
            if row['status'] == 'received':
                if not self.cfg.get('printing_enabled'):
                    return
                if printer not in printers:
                    raise RuntimeError('configured printer is missing: ' + printer)
                p = printers[printer]
                if p.get('printer-state') == 5 or not p.get('printer-is-accepting-jobs', True):
                    raise RuntimeError('printer stopped/not accepting: ' + str(p.get('printer-state-message', '')))
                data = render(json.loads(row['payload']), row['received'], self.cfg, bool(row['reprint']))
                self.store.update(row['id'], status='printing', phase='creating')
                LOG.info('print_attempt id=%s job=%s', row['external_id'], row['id'])
                # Create HELD job, durably save ID, upload, durably mark sent, then release.
                # Crash before sent: held job cannot print and requires manual inspection.
                jid = c.createJob(printer, row['token'], {'job-hold-until': 'indefinite', 'job-sheets': 'none,none'})
                self.store.update(row['id'], cups_id=jid, phase='uploading')
                c.startDocument(printer, jid, 'receipt.bin', 'application/vnd.cups-raw', 1)
                c.writeRequestData(data, len(data))
                c.finishDocument(printer)
                self.store.update(row['id'], phase='sent')
                row.update(cups_id=jid, phase='sent')
            jid = row['cups_id']
            if not jid:
                matches = [(j, a) for j, a in c.getJobs(which_jobs='all', my_jobs=False).items() if a.get('job-name') == row['token']]
                if len(matches) == 1:
                    jid = matches[0][0]
                    self.store.update(row['id'], cups_id=jid)
                self.fail(row, 'Interrupted creation; manual inspection required; no automatic retry')
                continue
            if row['phase'] in ('creating', 'uploading'):
                self.fail(row, 'Interrupted upload; CUPS job remains held; inspect/cancel before manual reprint')
                continue
            try:
                attrs = c.getJobAttributes(jid)
            except Exception as exc:
                # Missing history is ambiguous, not permission to print again.
                if getattr(exc, 'args', (None,))[0] == 1030:
                    self.fail(row, 'CUPS history missing; manual inspection required')
                    continue
                raise
            state = attrs.get('job-state')
            if state == 9:
                self.store.update(row['id'], status='printed', phase='complete', finished=now())
                LOG.info('cups_completed id=%s job=%s cups=%s', row['external_id'], row['id'], jid)
            elif state in (7, 8):
                self.fail(row, 'CUPS canceled/aborted: ' + str(attrs.get('job-state-reasons', [])))
            elif state == 4 and row['phase'] == 'sent':
                c.setJobHoldUntil(jid, 'no-hold')
                self.store.update(row['id'], phase='released')
                LOG.info('released id=%s cups=%s', row['external_id'], jid)
            elif state == 6:
                raise RuntimeError('CUPS job stopped: ' + str(attrs.get('job-state-reasons', [])))

    def run(self):
        import cups
        last_error = None
        while not STOP.is_set():
            try:
                self.step(cups.Connection())
                if self.online is False:
                    LOG.info('connection_recovered cups/printer')
                self.online = True
                last_error = None
            except Exception as exc:
                message = str(exc)
                if message != last_error:
                    self.store.event_error(message)
                    LOG.exception('cups/printer_error %s', message)
                    last_error = message
                self.online = False
            STOP.wait(3)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('API redirects are disabled')

def poll(agent):
    cfg = agent.cfg
    if cfg.get('site_api_url'):
        from site_protocol import run
        return run(agent, STOP, LOG)
    url = cfg.get('poll_url', '')
    if not url:
        return
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('poll_url must be HTTPS without embedded credentials')
    opener = build_opener(NoRedirect())
    was_up = True
    while not STOP.is_set():
        try:
            req = Request(url, headers={'Authorization': 'Bearer ' + cfg['poll_token'], 'Accept': 'application/json'})
            with opener.open(req, timeout=20) as response:
                raw = response.read(1048577)
            if len(raw) > 1048576:
                raise ValueError('API response too large')
            payload = json.loads(raw)
            jobs = payload['jobs']
            if not isinstance(jobs, list) or len(jobs) > 100:
                raise ValueError('API must return at most 100 jobs')
            for job in jobs:
                agent.store.receive(job)
            if not was_up:
                LOG.info('connection_recovered site_api')
            was_up = True
        except Exception as exc:
            if was_up:
                agent.store.event_error('API: ' + str(exc))
                LOG.error('site_api_error %s', exc)
            was_up = False
        STOP.wait(max(5, int(cfg.get('poll_seconds', 15))))

def handler(agent):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass  # No tokens or order contents in access logs.

        def reply(self, code, data):
            body = json.dumps(data, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            token = 'Bearer ' + agent.cfg['api_token']
            if not hmac.compare_digest(self.headers.get('Authorization', ''), token):
                self.reply(401, {'error': 'unauthorized'})
                return False
            return True

        def do_GET(self):
            if not self.authorized():
                return
            if self.path == '/health':
                self.reply(200, agent.health())
            elif self.path == '/jobs':
                with agent.store.db() as db:
                    rows = [dict(r) for r in db.execute('SELECT * FROM jobs ORDER BY id DESC LIMIT 100')]
                self.reply(200, {'jobs': rows})
            else:
                self.reply(404, {'error': 'not found'})

        def do_POST(self):
            if not self.authorized():
                return
            try:
                self.connection.settimeout(10)
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 262144:
                    raise ValueError('body must be 1..262144 bytes')
                data = json.loads(self.rfile.read(size))
                if self.path == '/jobs':
                    row, duplicate = agent.store.receive(data)
                    self.reply(200 if duplicate else 201, {'job': row, 'duplicate': duplicate})
                elif self.path == '/reprint':
                    self.reply(201, {'job': agent.store.reprint(data['type'], data['id'])})
                else:
                    self.reply(404, {'error': 'not found'})
            except QueueFull:
                self.reply(503, {'error': 'QUEUE_FULL'})
            except (ValueError, KeyError, TypeError, InvalidOperation) as exc:
                self.reply(400, {'error': str(exc)})
            except Exception as exc:
                agent.store.event_error(str(exc))
                LOG.exception('request_failed')
                self.reply(503, {'error': 'operation unavailable; inspect health/logs'})
    return Handler

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['serve', 'health', 'jobs', 'submit', 'reprint'])
    parser.add_argument('argument', nargs='?')
    parser.add_argument('--type', default='cafe_order', choices=['cafe_order', 'shift_report'])
    args = parser.parse_args()
    cfg = json.loads(Path(CONFIG).read_text())
    if args.command != 'serve':
        path = '/health' if args.command == 'health' else '/jobs'
        data = None
        if args.command == 'submit':
            data = Path(args.argument).read_bytes()
        elif args.command == 'reprint':
            path = '/reprint'
            data = json.dumps({'type': args.type, 'id': args.argument}).encode()
        req = Request('http://127.0.0.1:' + str(cfg.get('port', 8765)) + path, data=data,
                      headers={'Authorization': 'Bearer ' + cfg['api_token'], 'Content-Type': 'application/json'})
        try:
            with urlopen(req, timeout=30) as response:
                print(json.dumps(json.load(response), ensure_ascii=False, indent=2))
        except HTTPError as exc:
            print(exc.read().decode('utf-8', errors='replace'), file=sys.stderr)
            raise SystemExit(1)
        except URLError as exc:
            print('Agent unavailable: ' + str(exc.reason), file=sys.stderr)
            raise SystemExit(1)
        return
    os.umask(0o077)
    if fcntl is None:
        raise RuntimeError('Serving requires Linux file locking')
    process_lock = open(str(Path(cfg['database']).with_suffix('.lock')), 'a')
    fcntl.flock(process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    file_handler = RotatingFileHandler(cfg['log_file'], maxBytes=2*1024*1024, backupCount=4, encoding='utf-8')
    logging.basicConfig(level=logging.INFO, handlers=[file_handler, logging.StreamHandler()], format='%(asctime)s %(levelname)s %(message)s')
    agent = Agent(cfg)
    if cfg.get('site_api_url'):
        from site_protocol import SiteClient
        SiteClient(agent)  # Validate before starting any worker.
        if cfg.get('poll_url'):
            raise ValueError('Use site_api_url OR legacy poll_url, not both')
    # Validate optional API before starting threads, so bad config fails visibly.
    parsed = urlparse(cfg.get('poll_url', ''))
    if cfg.get('poll_url') and (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or not cfg.get('poll_token')):
        raise ValueError('valid HTTPS URL and poll_token required')
    server = ThreadingHTTPServer(('127.0.0.1', int(cfg.get('port', 8765))), handler(agent))
    server.daemon_threads = True
    server.timeout = 1
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    threading.Thread(target=agent.run, daemon=True).start()
    threading.Thread(target=poll, args=(agent,), daemon=True).start()
    LOG.info('agent_started printer=%s printing_enabled=%s', cfg.get('printer'), cfg.get('printing_enabled'))
    while not STOP.is_set():
        server.handle_request()
    server.server_close()
    LOG.info('agent_stopped')

if __name__ == '__main__':
    main()
