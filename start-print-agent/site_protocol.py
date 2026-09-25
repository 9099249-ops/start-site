"""Outgoing HTTPS protocol. No inbound LAN port or website-provided callback URL."""
import json
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.parse import urlparse

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('API redirects are disabled')

class SiteClient:
    def __init__(self, agent):
        self.agent = agent
        self.cfg = agent.cfg
        self.base = self.cfg['site_api_url'].rstrip('/')
        parsed = urlparse(self.base)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('site_api_url must be HTTPS without credentials, query or fragment')
        if len(self.cfg.get('poll_token', '')) < 32:
            raise ValueError('poll_token must contain at least 32 characters')
        self.opener = build_opener(NoRedirect())

    def request(self, path, body=None):
        headers = {'Authorization': 'Bearer ' + self.cfg['poll_token'], 'Accept': 'application/json',
                   'Content-Type': 'application/json', 'X-Print-Agent-Id': self.cfg.get('agent_id', 'station-printer-1'),
                   'X-Print-Database-Id': self.agent.store.database_id()}
        req = Request(self.base + '/' + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
        with self.opener.open(req, timeout=20) as response:
            raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError('API response too large')
        return json.loads(raw)

    def flush(self):
        events = self.agent.store.outbox()
        if not events:
            return
        result = self.request('events', {'events': events})
        accepted = result.get('accepted_event_ids')
        if not isinstance(accepted, list) or any(i not in {e['event_id'] for e in events} for i in accepted):
            raise ValueError('invalid event acknowledgement')
        self.agent.store.acknowledge(accepted)

    def once(self):
        self.flush()
        self.request('heartbeat', {**self.agent.health(), 'protocol_version': 1})
        result = self.request('jobs')
        jobs = result.get('jobs')
        if result.get('protocol_version') != 1 or not isinstance(jobs, list) or len(jobs) > 100:
            raise ValueError('invalid protocol response')
        for envelope in jobs:
            # QueueFull/network errors retain the same delivery for the next poll.
            # Malformed documents with a valid envelope get a durable failed event.
            self.agent.store.receive_envelope(envelope)
        self.flush()

def run(agent, stop, log):
    client = SiteClient(agent)
    delay = max(5, int(agent.cfg.get('poll_seconds', 15)))
    failures = 0
    while not stop.is_set():
        try:
            client.once()
            if failures:
                log.info('connection_recovered site_api')
            failures = 0
        except Exception as exc:
            # Do not log request URLs, tokens, payloads or remote response bodies.
            if not failures:
                log.error('site_api_unavailable type=%s status=%s', type(exc).__name__, getattr(exc, 'code', 'n/a'))
            failures += 1
        stop.wait(min(60, delay * (2 ** min(failures, 3))))
