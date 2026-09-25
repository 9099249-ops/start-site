#!/bin/sh
set -eu
test "$(id -u)" = 0
cd "$(dirname "$0")"
getent passwd start-print-agent >/dev/null || useradd --system --user-group --home-dir /var/lib/start-print-agent --shell /usr/sbin/nologin start-print-agent
usermod -aG lp start-print-agent
install -d -m 755 /opt/start-print-agent /opt/start-print-agent/examples
install -d -m 750 -o root -g start-print-agent /etc/start-print-agent
install -d -m 700 -o start-print-agent -g start-print-agent /var/lib/start-print-agent /var/log/start-print-agent
install -m 644 main.py site_protocol.py README.md tests.py test_protocol.py /opt/start-print-agent/
install -m 644 examples/*.json /opt/start-print-agent/examples/
if [ ! -e /etc/start-print-agent/config.json ]; then
python3 - <<'PY'
import json, os, secrets
path='/etc/start-print-agent/config.json'
cfg=dict(printer='start-kitchen', printing_enabled=False, width_dots=576, cut=True, beep_hex='',
         database='/var/lib/start-print-agent/queue.sqlite3', log_file='/var/log/start-print-agent/agent.log',
         api_token=secrets.token_urlsafe(32), port=8765, poll_url='', poll_token='', poll_seconds=15,
         site_api_url='', agent_id='station-printer-1')
with open(path,'x') as f: json.dump(cfg,f,indent=2)
os.chmod(path,0o640)
PY
chown root:start-print-agent /etc/start-print-agent/config.json
fi
install -m 644 start-print-agent.service /etc/systemd/system/start-print-agent.service
printf '#!/bin/sh\nexec /usr/bin/python3 /opt/start-print-agent/main.py "$@"\n' > /usr/local/bin/start-print
chmod 755 /usr/local/bin/start-print
systemctl daemon-reload
systemctl enable start-print-agent.service
systemctl restart start-print-agent.service
for attempt in 1 2 3 4 5; do
    if /usr/local/bin/start-print health >/dev/null 2>&1; then exit 0; fi
    sleep 1
done
echo 'Agent health not ready; inspect systemctl status start-print-agent' >&2
exit 1
